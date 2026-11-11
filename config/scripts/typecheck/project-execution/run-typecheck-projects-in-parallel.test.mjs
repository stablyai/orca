import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as processHost from '@orca/process-host'
import {
  MOBILE_JOINED_PROJECT,
  MOBILE_TYPECHECK_PROJECTS,
  runMobileHostTypecheck,
  runTypecheckProjects
} from './run-typecheck-projects-in-parallel.mjs'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

describe('local and CI compiler selection', () => {
  it('continues to later projects after a compiler exits with an error', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-typecheck-failure-')))
    try {
      const compilerDir = join(root, 'node_modules', 'typescript')
      mkdirSync(compilerDir, { recursive: true })
      mkdirSync(join(root, 'config'))
      writeFileSync(
        join(compilerDir, 'package.json'),
        JSON.stringify({ name: 'typescript', bin: { tsc: 'compiler.cjs' } })
      )
      writeFileSync(
        join(compilerDir, 'compiler.cjs'),
        "const fs = require('node:fs'); const config = process.argv.at(-1); fs.appendFileSync('checked.txt', config + '\\n'); process.exit(config.includes('broken') ? 1 : 0)"
      )
      const failures = await runTypecheckProjects({
        root,
        projects: [
          { config: 'config/broken.json', heapGib: 1 },
          { config: 'config/healthy.json', heapGib: 1 }
        ],
        memoryBytes: 2 * 1024 ** 3,
        parallelism: 1
      })
      expect(failures).toHaveLength(1)
      expect(failures[0].message).toContain('broken.json exited with code 1')
      expect(readFileSync(join(root, 'checked.txt'), 'utf8')).toBe(
        'config/broken.json\nconfig/healthy.json\n'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Mobile declaration consumer lifetime', () => {
  const fixtures = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of fixtures.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function phaseFixture(analyze = async () => {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-mobile-lifetime-')))
    fixtures.push(root)
    const output = join(root, '.cache/typecheck/mobile-project-controls-host')
    const compiler = join(root, 'node_modules/typescript')
    mkdirSync(compiler, { recursive: true })
    writeFileSync(
      join(compiler, 'package.json'),
      JSON.stringify({ version: '7.0.2', bin: 'never-executed.cjs' })
    )
    mkdirSync(join(root, 'src/renderer/src'), { recursive: true })
    writeFileSync(join(root, 'src/renderer/src/env.d.ts'), '// ambient lifetime sentinel\n')
    const declarationConfig = 'config/tsconfig.test.project-grouping-host-declarations.json'
    mkdirSync(join(root, 'config'), { recursive: true })
    const configSource = readFileSync(join(repoRoot, declarationConfig), 'utf8')
    writeFileSync(join(root, declarationConfig), configSource)
    const inputs = JSON.parse(configSource).files
    const calls = []
    vi.spyOn(processHost, 'runProcess').mockImplementation(async (spec) => {
      calls.push(spec)
      if (spec.program === 'fixture-analyzer') {
        return analyze(spec)
      }
      if (spec.args.includes('config/tsconfig.test.project-grouping-host-declarations.json')) {
        for (const input of inputs.filter((file) => !file.endsWith('.d.ts'))) {
          const file = join(output, input.slice(3).replace(/\.tsx?$/, '.d.ts'))
          mkdirSync(join(file, '..'), { recursive: true })
          // Only output-lifetime sentinels; no generated API or real compiler is substituted.
          writeFileSync(file, '// output lifetime sentinel\n')
        }
      }
      spec.onChildTerminated()
      return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' }
    })
    return {
      root,
      output,
      calls,
      options: {
        root,
        compiler: 'bun',
        bunExecutable: 'fixture-bun',
        bunThreads: 2,
        projects: MOBILE_TYPECHECK_PROJECTS.filter((project) =>
          ['mobile/tsconfig.json', MOBILE_JOINED_PROJECT].includes(project.config)
        )
      }
    }
  }

  it('holds current output until the owned deferred consumer fully terminates', async () => {
    let release
    let entered
    const started = new Promise((resolve) => {
      entered = resolve
    })
    const deferred = new Promise((resolve) => {
      release = resolve
    })
    const external = new AbortController()
    const foreignTermination = vi.fn()
    const fixture = phaseFixture(async (spec) => {
      expect(spec.signal).not.toBe(external.signal)
      expect(spec.terminationBarrier).toBe(true)
      expect(spec.onChildTerminated).not.toBe(foreignTermination)
      expect(spec.stdio).toBe('pipe')
      expect(spec.maxOutputBytes).toBe(128)
      entered()
      await deferred
      spec.onChildTerminated()
      return { code: 1, signal: null, timedOut: false, stdout: 'diagnostic-result', stderr: '' }
    })
    let settled = false
    const phase = runMobileHostTypecheck({
      ...fixture.options,
      consumeDeclarations: async ({ runOwnedProcess }) => {
        expect(fixture.calls).toHaveLength(3)
        expect(readFileSync(join(fixture.output, 'src/renderer/src/env.d.ts'), 'utf8')).toBe(
          '// ambient lifetime sentinel\n'
        )
        const result = await runOwnedProcess({
          program: 'fixture-analyzer',
          args: [],
          stdio: 'pipe',
          maxOutputBytes: 128,
          signal: external.signal,
          terminationBarrier: false,
          onChildTerminated: foreignTermination
        })
        expect(result.code).toBe(1)
        expect(result.stdout).toBe('diagnostic-result')
      }
    }).then((failures) => {
      settled = true
      return failures
    })
    await started
    expect(existsSync(fixture.output)).toBe(true)
    expect(settled).toBe(false)
    release()
    expect(await phase).toEqual([])
    expect(existsSync(fixture.output)).toBe(false)
    expect(foreignTermination).not.toHaveBeenCalled()
  })

  it.each(['consumer-failure', 'interrupted', 'unverified'])(
    'keeps %s a failure and cleans only after verified child closure',
    async (outcome) => {
      let interrupt
      const originalOn = process.on
      vi.spyOn(process, 'on').mockImplementation(function (event, listener) {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          interrupt = listener
          return this
        }
        return originalOn.call(this, event, listener)
      })
      const fixture = phaseFixture(async (spec) => {
        if (outcome === 'interrupted') {
          interrupt()
        }
        if (outcome !== 'unverified') {
          spec.onChildTerminated()
        }
        return { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' }
      })
      const failures = await runMobileHostTypecheck({
        ...fixture.options,
        consumeDeclarations: async ({ runOwnedProcess }) => {
          await runOwnedProcess({ program: 'fixture-analyzer', args: [], stdio: 'pipe' })
          if (outcome === 'consumer-failure') {
            throw new Error('consumer parse failed')
          }
        }
      })
      expect(failures.length).toBeGreaterThan(0)
      expect(existsSync(fixture.output)).toBe(outcome === 'unverified')
    }
  )

  it('aborts and awaits an active child when the consumer throws before awaiting it', async () => {
    let release
    let aborted
    const stopping = new Promise((resolve) => {
      aborted = resolve
    })
    const deferred = new Promise((resolve) => {
      release = resolve
    })
    const fixture = phaseFixture(async (spec) => {
      spec.signal.addEventListener('abort', aborted, { once: true })
      await deferred
      spec.onChildTerminated()
      return { code: null, signal: 'SIGTERM', timedOut: false, stdout: '', stderr: '' }
    })
    let settled = false
    const phase = runMobileHostTypecheck({
      ...fixture.options,
      consumeDeclarations: ({ runOwnedProcess }) => {
        void runOwnedProcess({ program: 'fixture-analyzer', args: [], stdio: 'pipe' })
        throw new Error('consumer failed with child still active')
      }
    }).then((failures) => {
      settled = true
      return failures
    })
    await stopping
    expect(settled).toBe(false)
    expect(existsSync(fixture.output)).toBe(true)
    release()
    expect((await phase).length).toBeGreaterThan(0)
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('does not admit analysis after either required checker fails', async () => {
    const fixture = phaseFixture()
    const execute = processHost.runProcess.getMockImplementation()
    vi.spyOn(processHost, 'runProcess').mockImplementation(async (spec) => {
      const result = await execute(spec)
      return spec.args.includes('mobile/tsconfig.json') ? { ...result, code: 1 } : result
    })
    const consumeDeclarations = vi.fn()
    const failures = await runMobileHostTypecheck({ ...fixture.options, consumeDeclarations })
    expect(failures).toHaveLength(1)
    expect(consumeDeclarations).not.toHaveBeenCalled()
    expect(fixture.calls).toHaveLength(3)
    expect(existsSync(fixture.output)).toBe(false)
  })
})
