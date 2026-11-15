import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProviderProcess } from './provider-process-spawn'
import {
  createProviderSpawnSpec,
  type ProviderSupervisorOptions
} from './provider-process-supervisor'
import type { ProviderChild } from './provider-child'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))

const children: { child: ProviderChild; closed: Promise<void> }[] = []
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'orca-provider-launch-'))
})
afterEach(async () => {
  for (const { child } of children) {
    child.kill('SIGKILL')
  }
  await Promise.all(children.splice(0).map(({ closed }) => closed))
  await rm(state.root, { recursive: true, force: true })
})

type LaunchOptions = {
  args?: string[]
  command?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  captureOutput?: boolean
}

function launch(
  script: string,
  options: ProviderSupervisorOptions = {},
  {
    args = [],
    command = process.execPath,
    cwd = state.root,
    env = process.env,
    captureOutput = true
  }: LaunchOptions = {}
) {
  const spec = createProviderSpawnSpec(
    { command, args: ['-e', script, '--', ...args], cwd },
    env,
    process.platform,
    options
  )
  const child = spawnProviderProcess(spec)
  let output = ''
  let stderr = ''
  const errors: Error[] = []
  const readers = new Set<() => void>()
  child.on('error', (error) => errors.push(error))
  if (captureOutput) {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      for (const reader of readers) {
        reader()
      }
    })
  }
  if (captureOutput) {
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
  }
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  children.push({ child, closed })
  const untilOutput = (text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readers.delete(check)
        reject(new Error(`Missing output: ${text}; ${output}; ${stderr}`))
      }, 15_000)
      const check = (): void => {
        if (output.includes(text)) {
          clearTimeout(timer)
          readers.delete(check)
          resolve()
        }
      }
      readers.add(check)
      check()
    })
  return { child, exit, closed, errors, output: () => output, stderr: () => stderr, untilOutput }
}

async function readText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe.runIf(process.platform !== 'win32')('direct provider ownership', () => {
  it('publishes ownership before execution, preserves argv/environment, and drains the real final output', async () => {
    const run = launch(
      String.raw`
      const fs = require('node:fs')
      const path = require('node:path')
      const records = fs.readdirSync(process.env.ORCA_TEST_JOURNAL).filter(f => f.endsWith('.json'))
      const record = JSON.parse(fs.readFileSync(path.join(process.env.ORCA_TEST_JOURNAL, records[0]), 'utf8'))
      process.stdout.write(JSON.stringify({ pid: process.pid, leader: record.leader.pid, owner: record.owner.pid,
        argv: process.argv.slice(1), env: {
          ORCA_TEST_JOURNAL: process.env.ORCA_TEST_JOURNAL,
          ORCA_TEST_LITERAL: process.env.ORCA_TEST_LITERAL,
          NODE_OPTIONS: process.env.NODE_OPTIONS, PWD: process.env.PWD,
          SHLVL: process.env.SHLVL, _: process.env._,
          ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
          ORCA_PROVIDER_SUPERVISOR_SPEC: process.env.ORCA_PROVIDER_SUPERVISOR_SPEC
        } }) + '\n')
      process.stderr.write('final stderr\n')
      process.stdout.write('final stdout\n')
    `,
      { lifetime: 'one-shot' },
      {
        args: ['', 'a b&c', '--literal=$HOME', 'line\nbreak'],
        env: {
          ORCA_TEST_JOURNAL: join(state.root, 'provider-processes'),
          ORCA_TEST_LITERAL: 'a b&c\n$HOME',
          NODE_OPTIONS: '--no-warnings',
          PWD: '/literal/pwd',
          SHLVL: '7',
          _: 'literal_underscore'
        }
      }
    )
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    const first = JSON.parse(run.output().split('\n')[0])
    expect(first).toEqual({
      pid: run.child.pid,
      leader: run.child.pid,
      owner: process.pid,
      argv: ['', 'a b&c', '--literal=$HOME', 'line\nbreak'],
      env: {
        ORCA_TEST_JOURNAL: join(state.root, 'provider-processes'),
        ORCA_TEST_LITERAL: 'a b&c\n$HOME',
        NODE_OPTIONS: '--no-warnings',
        PWD: '/literal/pwd',
        SHLVL: '7',
        _: 'literal_underscore'
      }
    })
    expect(run.output().split('\n').slice(1).join('\n')).toBe('final stdout\n')
    expect(run.stderr()).toBe('final stderr\n')
    expect(run.errors).toEqual([])
    expect(run.child.groupVerdict).toBe('exited')
    expect(await readdir(join(state.root, 'provider-processes'))).toEqual([])
  })

  it('retains final bytes for readers attached after lifecycle exit', async () => {
    const run = launch(
      String.raw`
      process.stdout.end('final answer 🐳\n')
      process.stderr.end('final error\n')
    `,
      { lifetime: 'one-shot' },
      { captureOutput: false }
    )
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    await expect(
      Promise.all([readText(run.child.stdout), readText(run.child.stderr)])
    ).resolves.toEqual(['final answer 🐳\n', 'final error\n'])
  })

  it('does not treat one-shot stdin EOF as a stop', async () => {
    const run = launch(
      String.raw`
      let input = ''
      process.stdin.on('data', chunk => input += chunk)
      process.stdin.on('end', () => setTimeout(() => process.stdout.write('answer:' + input), 1_200))
    `,
      { lifetime: 'one-shot', stdinEndGraceMs: 20, sigtermGraceMs: 20 }
    )
    run.child.stdin.end('request')
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    expect(run.output()).toBe('answer:request')
  })

  it('reaps descendants immediately when the leader voluntarily exits on stdin EOF', async () => {
    const run = launch(String.raw`
      require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => { process.stdout.write('unexpected TERM\\n'); process.exit(42) }); process.stdout.write('descendant ready\\n'); setInterval(() => {}, 60000)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      process.stdin.resume().once('end', () => process.exit(17))
    `)
    await run.untilOutput('descendant ready')
    run.child.stdin.end()
    await expect(run.exit).resolves.toEqual({ code: 17, signal: null })
    expect(run.output()).toBe('descendant ready\n')
    expect(run.child.groupVerdict).toBe('exited')
  })

  it('keeps descendants in their remaining session grace after the leader exits', async () => {
    const run = launch(
      String.raw`
      const child = require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('descendant flushed\\n'); process.exit(0) }, 80)); process.stdout.write('descendant ready\\n'); setInterval(() => {}, 60000)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      process.on('SIGTERM', () => process.exit(23))
      setInterval(() => {}, 60000)
    `,
      { sigtermGraceMs: 400 }
    )
    await run.untilOutput('descendant ready')
    run.child.kill('SIGTERM')
    run.child.kill('SIGTERM')
    await expect(run.exit).resolves.toEqual({ code: 23, signal: null })
    expect(run.output()).toContain('descendant flushed')
    expect(run.child.groupVerdict).toBe('exited')
  })

  it('routes SIGUSR2 to immediate cleanup and retains the actual CLI signal', async () => {
    const run = launch(String.raw`
      process.on('SIGTERM', () => process.stdout.write('term received\n'))
      process.on('SIGUSR2', () => process.stdout.write('usr2 reached CLI\n'))
      process.stdout.write('ready\n')
      setInterval(() => {}, 60000)
    `)
    await run.untilOutput('ready')
    run.child.kill('SIGTERM')
    await run.untilOutput('term received')
    run.child.kill('SIGUSR2')
    await expect(run.exit).resolves.toEqual({ code: null, signal: 'SIGKILL' })
    expect(run.output()).not.toContain('usr2 reached CLI')
  })

  it('allows the full native TERM grace after a delayed watcher receives the request', async () => {
    const run = launch(
      String.raw`
      process.on('SIGTERM', () => setTimeout(() => {
        process.stdout.write('final result\n'); process.exit(0)
      }, 800))
      process.stdout.write('ready\n')
      setInterval(() => {}, 60000)
    `,
      { sigtermGraceMs: 1_000 }
    )
    await run.untilOutput('ready')
    const directory = join(state.root, 'provider-processes')
    const [name] = await readdir(directory)
    const { watcher } = JSON.parse(await readFile(join(directory, name), 'utf8'))
    process.kill(watcher.pid, 'SIGSTOP')
    try {
      run.child.kill('SIGTERM')
      await delay(500)
    } finally {
      process.kill(watcher.pid, 'SIGCONT')
    }
    await expect(run.exit).resolves.toEqual({ code: 0, signal: null })
    expect(run.output()).toBe('ready\nfinal result\n')
  })

  it('distinguishes native exec ENOENT from a CLI exit 127', async () => {
    const missing = launch(
      '',
      { lifetime: 'one-shot' },
      { command: join(state.root, 'absent-cli') }
    )
    await missing.closed
    expect(missing.errors[0]).toMatchObject({ code: 'ENOENT', providerExecutableMissing: true })
    const real = launch('process.exit(127)', { lifetime: 'one-shot' })
    await expect(real.exit).resolves.toEqual({ code: 127, signal: null })
    expect(real.errors).toEqual([])
  })

  it('classifies a missing working folder without blaming the provider executable', async () => {
    const run = launch('', { lifetime: 'one-shot' }, { cwd: join(state.root, 'missing-cwd') })
    await run.closed
    expect(run.errors[0]).toMatchObject({ code: 'ENOENT', providerLaunchFolderMissing: true })
    expect(run.errors[0]).not.toHaveProperty('providerExecutableMissing')
  })

  it('cancels a pending launch without releasing its execution gate', async () => {
    const run = launch("process.stdout.write('MUST NOT EXECUTE')", { lifetime: 'one-shot' })
    run.child.kill('SIGTERM')
    await expect(run.child.ready).rejects.toThrow()
    await run.closed
    expect(run.output()).toBe('')
  })

  it('cancels a stopped pending bootstrap without executing the CLI', async () => {
    const run = launch("process.stdout.write('MUST NOT EXECUTE')", { lifetime: 'one-shot' })
    run.child.kill('SIGSTOP')
    run.child.kill('SIGKILL')
    await expect(run.child.ready).rejects.toThrow()
    await run.closed
    expect(run.output()).toBe('')
  })

  it('keeps the execution gate shut when ownership publication fails', async () => {
    await writeFile(join(state.root, 'provider-processes'), 'blocked')
    const run = launch("process.stdout.write('MUST NOT EXECUTE')", { lifetime: 'one-shot' })
    await expect(run.child.ready).rejects.toThrow()
    await run.closed
    expect(run.output()).toBe('')
    expect(run.errors).toHaveLength(1)
  })
})
