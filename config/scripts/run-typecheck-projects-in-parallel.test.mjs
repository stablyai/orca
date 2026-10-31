import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolvePinnedBunExecutable } from './pinned-bun-executable.mjs'
import {
  MOBILE_TYPECHECK_PROJECTS,
  TYPECHECK_PROJECTS,
  admissibleHeapGib,
  planTypecheckBatches,
  resolveProjectCompiler,
  resolveTypecheckBunExecutable,
  resolveTypecheckCommand,
  parseTypecheckOptions,
  selectTypecheckCompiler,
  typecheckBatches,
  runTypecheckProjects
} from './run-typecheck-projects-in-parallel.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const CI_RUNNER = { totalBytes: 16 * 1024 ** 3, parallelism: 4 }
const DEV_LAPTOP = { totalBytes: 64 * 1024 ** 3, parallelism: 18 }

function planFor({ totalBytes, parallelism }, projects = TYPECHECK_PROJECTS) {
  return planTypecheckBatches(projects, {
    budgetGib: admissibleHeapGib(totalBytes),
    parallelism
  })
}

function batchOf(batches, config) {
  return batches.findIndex((batch) => batch.some((project) => project.config === config))
}

describe('typecheck project admission', () => {
  it('keeps the two expensive projects off the same CI runner', () => {
    const batches = planFor(CI_RUNNER)
    expect(batchOf(batches, 'config/tsconfig.node.json')).not.toBe(
      batchOf(batches, 'config/tsconfig.tc.web.json')
    )
  })

  it('holds every CI batch inside the memory budget', () => {
    const budget = admissibleHeapGib(CI_RUNNER.totalBytes)
    for (const batch of planFor(CI_RUNNER)) {
      const claimed = batch.reduce((total, project) => total + project.heapGib, 0)
      expect(claimed).toBeLessThanOrEqual(budget)
    }
  })

  it('still fills a CI batch with the cheap projects rather than serializing everything', () => {
    // Why: strict serialization measured ~60% slower than pairing the cheap work alongside.
    expect(planFor(CI_RUNNER).length).toBeLessThan(TYPECHECK_PROJECTS.length)
  })

  it('leaves a roomy machine fully parallel', () => {
    expect(planFor(DEV_LAPTOP)).toHaveLength(1)
  })

  it('serializes on a single core', () => {
    const batches = planFor({ totalBytes: 64 * 1024 ** 3, parallelism: 1 })
    expect(batches).toHaveLength(TYPECHECK_PROJECTS.length)
    expect(batches.every((batch) => batch.length === 1)).toBe(true)
  })

  it('runs a project that alone exceeds the budget instead of stalling', () => {
    const batches = planTypecheckBatches([{ config: 'huge.json', heapGib: 512 }], {
      budgetGib: admissibleHeapGib(2 * 1024 ** 3),
      parallelism: 4
    })
    expect(batches).toEqual([[{ config: 'huge.json', heapGib: 512 }]])
  })

  it('schedules every project exactly once', () => {
    const scheduled = planFor(CI_RUNNER)
      .flat()
      .map((project) => project.config)
      .sort()
    expect(scheduled).toEqual(TYPECHECK_PROJECTS.map((project) => project.config).sort())
  })

  it('never lets one project outgrow a CI runner on its own', () => {
    // A single project over budget runs anyway, so this is the ceiling the pool cannot rescue.
    const heaviest = Math.max(...TYPECHECK_PROJECTS.map((project) => project.heapGib))
    expect(heaviest).toBeLessThanOrEqual(admissibleHeapGib(CI_RUNNER.totalBytes))
  })
})

describe('workspace package test typecheck', () => {
  const packagesDir = join(repoRoot, 'src', 'packages')
  const packageTestProjects = readdirSync(packagesDir)
    .map((name) => join(packagesDir, name, 'tsconfig.test.json'))
    .filter((config) => existsSync(config))
    .map((config) => relative(repoRoot, config).split(sep).join('/'))

  it('type-checks every package test project, which no root project includes', () => {
    expect(packageTestProjects).toContain('src/packages/process-host/tsconfig.test.json')
    const scheduled = TYPECHECK_PROJECTS.map((project) => project.config)
    expect(scheduled).toEqual(expect.arrayContaining(packageTestProjects))
  })

  it("resolves a package project's compiler from that package, not the root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-typecheck-compiler-')))
    try {
      const writeCompiler = (directory, version) => {
        const compilerDir = join(root, directory, 'node_modules', 'typescript')
        mkdirSync(join(compilerDir, 'bin'), { recursive: true })
        writeFileSync(
          join(compilerDir, 'package.json'),
          JSON.stringify({ name: 'typescript', version, bin: { tsc: './bin/tsc' } })
        )
        return join(compilerDir, 'bin', 'tsc')
      }
      const rootCompiler = writeCompiler('.', '6.0.0')
      const packageCompiler = writeCompiler('src/packages/example', '7.0.0')
      mkdirSync(join(root, 'config'))

      expect(resolveProjectCompiler('src/packages/example/tsconfig.test.json', root)).toBe(
        packageCompiler
      )
      expect(resolveProjectCompiler('config/tsconfig.node.json', root)).toBe(rootCompiler)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('local and CI compiler selection', () => {
  it('defaults to automatic compiler selection while CI explicitly selects Bun', () => {
    expect(parseTypecheckOptions([]).compiler).toBe('auto')
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(manifest.scripts['typecheck:ci']).toContain('--compiler=bun')
  })

  it.each([
    ['darwin', 'arm64', 'tsrs'],
    ['linux', 'x64', 'tsrs'],
    ['linux', 'arm64', 'tsrs'],
    ['darwin', 'x64', 'bun'],
    ['win32', 'x64', 'bun'],
    ['win32', 'arm64', 'bun']
  ])('selects %s/%s without probing an unsupported binary', (platform, arch, compiler) => {
    const selection = selectTypecheckCompiler('auto', {
      root: repoRoot,
      platform,
      arch,
      resolveBunExecutable: () => {
        if (compiler !== 'bun') {
          throw new Error('unexpected Bun probe')
        }
        return 'pinned-bun'
      }
    })
    expect(selection.compiler).toBe(compiler)
  })

  it('rejects explicitly requested tsrs on an unsupported platform', () => {
    expect(() => selectTypecheckCompiler('tsrs', { platform: 'win32', arch: 'x64' })).toThrow(
      'use --compiler=bun'
    )
    expect(parseTypecheckOptions(['--compiler=tsrs']).compiler).toBe('tsrs')
  })

  it('bounds local tsrs concurrency and respects memory admission', () => {
    for (const memoryBytes of [4, 16, 128].map((gib) => gib * 1024 ** 3)) {
      const batches = typecheckBatches(TYPECHECK_PROJECTS, {
        compiler: 'tsrs',
        memoryBytes,
        parallelism: 16
      })
      expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(2)
      if (memoryBytes === 4 * 1024 ** 3) {
        expect(batches.every((batch) => batch.length === 1)).toBe(true)
      }
    }
  })

  it('pins the Bun devDependency to config/.bun-version', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(manifest.devDependencies.bun).toBe(
      readFileSync(join(repoRoot, 'config', '.bun-version'), 'utf8').trim()
    )
  })

  it('narrows to the requested projects and rejects unknown ones', () => {
    expect(parseTypecheckOptions(['--project=config/tsconfig.node.json']).projects).toEqual([
      TYPECHECK_PROJECTS[0]
    ])
    expect(parseTypecheckOptions([]).projects).toEqual(TYPECHECK_PROJECTS)
    expect(parseTypecheckOptions(['--project=mobile/tsconfig.test.json']).projects).toEqual([
      MOBILE_TYPECHECK_PROJECTS[1]
    ])
    expect(TYPECHECK_PROJECTS).not.toContainEqual(MOBILE_TYPECHECK_PROJECTS[0])
    expect(() => parseTypecheckOptions(['--project=config/tsconfig.json'])).toThrow()
  })

  it('selects the resolved Bun path and rejects a missing executable', () => {
    expect(
      selectTypecheckCompiler('bun', {
        root: repoRoot,
        resolveBunExecutable: () => '/repo/node_modules/bun/bin/bun.exe'
      })
    ).toEqual({ compiler: 'bun', bunExecutable: '/repo/node_modules/bun/bin/bun.exe' })
    expect(() =>
      selectTypecheckCompiler('bun', { root: repoRoot, resolveBunExecutable: () => null })
    ).toThrow('run pnpm install')
  })

  it('reports a timed-out installed Bun probe without changing optional fallback', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-bun-probe-')))
    try {
      const manifest = join(root, 'node_modules', 'bun')
      mkdirSync(manifest, { recursive: true })
      mkdirSync(join(root, 'config'))
      writeFileSync(join(root, 'package.json'), '{}')
      writeFileSync(join(root, 'config', '.bun-version'), '1.4.4')
      writeFileSync(join(manifest, 'package.json'), JSON.stringify({ bin: { bun: 'bin/bun' } }))
      const execute = () => ({ code: null, signal: 'SIGTERM', stdout: '', timedOut: true })
      expect(resolvePinnedBunExecutable(root, execute)).toBeNull()
      expect(() =>
        selectTypecheckCompiler('bun', {
          root,
          resolveBunExecutable: (directory, hint) =>
            resolveTypecheckBunExecutable(directory, hint, execute)
        })
      ).toThrow(/Bun version probe timed out after 2000 ms: .*or pass --compiler=native\./)
      expect(() => resolveTypecheckBunExecutable(root, null, execute)).toThrow(
        /Retry when the host is less busy\.$/
      )
      expect(
        resolveTypecheckBunExecutable(root, null, () => ({ code: 0, stdout: '1.4.4\n' }))
      ).toBe(join(manifest, 'bin/bun'))
      expect(
        resolveTypecheckBunExecutable(root, null, () => ({ code: 0, stdout: '1.4.3\n' }))
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never probes Bun when tsc is requested', () => {
    expect(
      selectTypecheckCompiler('native', {
        root: repoRoot,
        resolveBunExecutable: () => {
          throw new Error('probed')
        }
      })
    ).toEqual({ compiler: 'native' })
  })

  it.each([
    '--compiler=typo',
    '--bun-concurrency=0',
    '--bun-threads=NaN',
    '--bun-concurrency=5',
    '--checkers=0',
    '--checkers=two',
    '--project'
  ])('rejects unsafe or unknown options: %s', (argument) => {
    expect(() => parseTypecheckOptions([argument])).toThrow()
  })

  it('passes a checker cap to the native compiler only when one is requested', () => {
    const command = (checkers) =>
      resolveTypecheckCommand('config/tsconfig.node.json', {
        compiler: 'native',
        checkers,
        root: repoRoot
      }).args
    expect(command(parseTypecheckOptions(['--checkers=4']).checkers).slice(-2)).toEqual([
      '--checkers',
      '4'
    ])
    expect(command(parseTypecheckOptions([]).checkers)).not.toContain('--checkers')
  })

  it('bounds Bun project concurrency and reserves memory for overlapping checks', () => {
    const options = parseTypecheckOptions([
      '--compiler=bun',
      '--bun-concurrency=2',
      '--bun-threads=2'
    ])
    const batches = typecheckBatches(TYPECHECK_PROJECTS, {
      ...options,
      memoryBytes: CI_RUNNER.totalBytes,
      parallelism: 4
    })
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1])
    expect(batches.flat().map((project) => project.config)).toEqual(
      TYPECHECK_PROJECTS.map((project) => project.config)
    )
    expect(
      typecheckBatches(TYPECHECK_PROJECTS, {
        ...options,
        memoryBytes: 4 * 1024 ** 3,
        parallelism: 4
      }).every((batch) => batch.length === 1)
    ).toBe(true)
  })

  it('rejects a mismatched package compiler before invoking Bun', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-bun-compiler-version-')))
    try {
      mkdirSync(join(root, 'node_modules', 'typescript'), { recursive: true })
      writeFileSync(
        join(root, 'node_modules', 'typescript', 'package.json'),
        JSON.stringify({ name: 'typescript', version: '8.0.0', bin: 'compiler.cjs' })
      )
      const failures = await runTypecheckProjects({
        compiler: 'bun',
        root,
        projects: [{ config: 'tsconfig.json', heapGib: 1 }]
      })
      expect(failures).toHaveLength(1)
      expect(failures[0].message).toContain('resolves 8.0.0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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
