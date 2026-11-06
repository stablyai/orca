import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS,
  supervisedPosixLaunch,
  type ProviderSupervisorOptions
} from './provider-process-supervisor'
import { supervisedProviderSpawnFailure } from './provider-spawn-failure-report'

// The provider leads its own group; its grandchild shares that group and ignores SIGTERM.
const PROVIDER = String.raw`
  const { spawn } = require('node:child_process')
  if (process.env.ORCA_TEST_PROVIDER_IGNORES_SIGTERM) process.on('SIGTERM', () => {})
  if (process.env.ORCA_TEST_PROVIDER_SIGNAL_FILE) {
    process.on('SIGTERM', () => {
      require('node:fs').writeFileSync(process.env.ORCA_TEST_PROVIDER_SIGNAL_FILE, 'SIGTERM')
      process.exit(0)
    })
  }
  process.stdout.on('error', () => {})
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 60000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  grandchild.stdout.once('data', () => {
    process.stdout.write(JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }) + '\n')
    if (process.env.ORCA_TEST_PROVIDER_STREAMS_OUTPUT) setInterval(() => process.stdout.write('.'), 2)
  })
  setInterval(() => {}, 60000)
`

// Dies on SIGTERM at once; its grandchild, like an MCP server or a tool's child, needs 300 ms to clean up.
const CLEANS_UP_AFTER_SIGTERM_PROVIDER = String.raw`
  const { spawn } = require('node:child_process')
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync(process.env.ORCA_TEST_CLEANUP_FILE, 'done'); process.exit(0) }, 300)); process.stdout.write('armed'); setInterval(() => {}, 60000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  grandchild.stdout.once('data', () =>
    process.stdout.write(JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }) + '\n')
  )
  setInterval(() => {}, 60000)
`
void String.raw`
  process.stdin.on('end', () => process.exit(0)).resume()
  process.stdout.write(JSON.stringify({ provider: process.pid }) + '\n')
`

// Flushes for a moment once its stdin ends, then exits; records a SIGTERM if one arrives first.
const FLUSHES_ON_STDIN_END_PROVIDER = String.raw`
  const { writeFileSync } = require('node:fs')
  process.on('SIGTERM', () => {
    writeFileSync(process.env.ORCA_TEST_PROVIDER_SIGNAL_FILE, 'SIGTERM')
    process.exit(143)
  })
  process.stdin.on('end', () => setTimeout(() => {
    writeFileSync(process.env.ORCA_TEST_PROVIDER_FLUSH_FILE, 'flushed')
    process.exit(0)
  }, 200)).resume()
  process.stdout.write(JSON.stringify({ provider: process.pid }) + '\n')
`
void String.raw`
  process.on('SIGTERM', () => {
    require('node:fs').writeFileSync(process.env.ORCA_TEST_PROVIDER_SIGNAL_FILE, String(Date.now()))
  })
  process.stdout.write(JSON.stringify({ provider: process.pid }) + '\n')
  setInterval(() => {}, 60000)
`

// Answers a one-shot request only after the session stdin-end grace, then exits with its own code.
const ONE_SHOT_PROVIDER = String.raw`
  process.on('SIGTERM', () => {
    require('node:fs').writeFileSync(process.env.ORCA_TEST_PROVIDER_SIGNAL_FILE, 'SIGTERM')
  })
  process.stdin.resume().on('end', () => {
    setTimeout(() => {
      process.stdout.write('ok')
      process.exitCode = 3
    }, Number(process.env.ORCA_TEST_PROVIDER_ANSWER_DELAY_MS))
  })
`

// A sibling holds stdin open to isolate parent-death detection; other modes model clean quit and one-shot requests.
const OWNER = String.raw`
  const { spawn } = require('node:child_process')
  const quitsCleanly = Boolean(process.env.ORCA_TEST_OWNER_QUITS_CLEANLY)
  const endsStdin = Boolean(process.env.ORCA_TEST_OWNER_ENDS_STDIN)
  if (quitsCleanly) process.on('SIGUSR2', () => process.exit(0))
  const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
  spec.ownerPid = process.pid
  const supervisor = spawn(process.execPath, JSON.parse(process.env.ORCA_TEST_SUPERVISOR_ARGS), {
    env: { ...process.env, ORCA_PROVIDER_SUPERVISOR_SPEC: Buffer.from(JSON.stringify(spec)).toString('base64') },
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true
  })
  if (endsStdin) supervisor.stdin.end()
  const holder = quitsCleanly || endsStdin
    ? null
    : spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: ['ignore', supervisor.stdin, 'ignore']
      })
  process.stdout.write(JSON.stringify({ supervisor: supervisor.pid, ...(holder && { holder: holder.pid }) }) + '\n')
  supervisor.stdout.pipe(process.stdout)
  setInterval(() => {}, 60000)
`

// Preloaded into the supervisor: signals it the instant its provider exists, the spawn window.
const SIGNAL_AFTER_SPAWN_PRELOAD = String.raw`
  const childProcess = require('node:child_process')
  const spawn = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = spawn(...args)
    require('node:fs').writeFileSync(process.env.ORCA_TEST_PROVIDER_PID_FILE, String(child.pid))
    process.kill(process.pid, 'SIGTERM')
    return child
  }
`

// Preloaded into the supervisor: its spawn fails the way EMFILE does, with no pid and no pipes.
const SPAWN_WITHOUT_PID_PRELOAD = String.raw`
  const childProcess = require('node:child_process')
  const { EventEmitter } = require('node:events')
  childProcess.spawn = (command) => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: null, stdout: null, stderr: null })
    process.nextTick(() =>
      child.emit('error', Object.assign(new Error('spawn ' + command + ' EMFILE'), { code: 'EMFILE' }))
    )
    return child
  }
`

const recordedPids = new Set<number>()
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-supervisor-'))
  tempDirs.push(dir)
  return dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function readPids(child: ChildProcess, keys: readonly string[]): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const pids: Record<string, number> = {}
    let buffered = ''
    const timeout = setTimeout(() => reject(new Error(`no ${keys.join('/')} pids`)), 10_000)
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line)
        for (const [key, pid] of Object.entries(parsed ?? {})) {
          if (typeof pid === 'number') {
            pids[key] = pid
            recordedPids.add(pid)
          }
        }
      }
      if (keys.every((key) => key in pids)) {
        clearTimeout(timeout)
        // Removing the data listener leaves the stream flowing; later output is not PID metadata.
        child.stdout!.off('data', onData)
        resolve(pids)
      }
    }
    child.stdout!.on('data', onData)
  })
}

function launchSupervisor(
  options: ProviderSupervisorOptions,
  env: Record<string, string> = {},
  provider: { command: string; args: string[] } = {
    command: process.execPath,
    args: ['-e', PROVIDER]
  },
  nodeArgs: string[] = [],
  stderr: 'pipe' | 'ignore' = 'ignore'
): { supervisor: ChildProcess; exit: Promise<{ code: number | null; signal: string | null }> } {
  const launch = supervisedPosixLaunch(provider, { ...process.env, ...env }, options)
  const supervisor = spawn(launch.command, [...nodeArgs, ...launch.args], {
    env: launch.env,
    stdio: ['pipe', 'pipe', stderr],
    detached: true
  })
  recordedPids.add(supervisor.pid!)
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    supervisor.once('exit', (code, signal) => resolve({ code, signal }))
  )
  return { supervisor, exit }
}

async function launchUnderOwner(
  options: ProviderSupervisorOptions,
  env: Record<string, string> = {},
  provider: { script: string; pids: readonly string[] } = {
    script: PROVIDER,
    pids: ['provider', 'grandchild']
  }
): Promise<{ owner: ChildProcess; pids: Record<string, number> }> {
  const launch = supervisedPosixLaunch(
    { command: process.execPath, args: ['-e', provider.script] },
    { ...process.env, ...env },
    options
  )
  const owner = spawn(process.execPath, ['-e', OWNER], {
    env: { ...launch.env, ORCA_TEST_SUPERVISOR_ARGS: JSON.stringify(launch.args) },
    stdio: ['ignore', 'pipe', 'ignore']
  })
  recordedPids.add(owner.pid!)
  const pids = await readPids(owner, ['supervisor', ...provider.pids])
  return { owner, pids }
}

afterEach(() => {
  for (const pid of recordedPids) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  recordedPids.clear()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.runIf(process.platform !== 'win32')('POSIX provider supervisor processes', () => {
  it('reaps the provider group on SIGTERM and exits only after the group is gone', async () => {
    const { supervisor, exit } = launchSupervisor({ sigtermGraceMs: 300 })
    const { provider, grandchild } = await readPids(supervisor, ['provider', 'grandchild'])

    let groupAliveAtExit: boolean | null = null
    void exit.then(() => {
      groupAliveAtExit = alive(-provider)
    })
    supervisor.kill('SIGTERM')

    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM' })
    expect(groupAliveAtExit).toBe(false)
    expect(alive(provider)).toBe(false)
    expect(alive(grandchild)).toBe(false)
  })

  it('lets a session provider group finish its SIGTERM cleanup after the provider exits', async () => {
    const cleanupFile = join(tempDir(), 'grandchild-cleaned-up')
    const { supervisor, exit } = launchSupervisor(
      {},
      { ORCA_TEST_CLEANUP_FILE: cleanupFile },
      { command: process.execPath, args: ['-e', CLEANS_UP_AFTER_SIGTERM_PROVIDER] }
    )
    await readPids(supervisor, ['provider', 'grandchild'])

    supervisor.kill('SIGTERM')

    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM' })
    expect(existsSync(cleanupFile)).toBe(true)
  })

  it('reaps a provider spawned in the instant before a stop arrives', async () => {
    const dir = tempDir()
    const preload = join(dir, 'signal-after-spawn.js')
    const pidFile = join(dir, 'provider-pid')
    writeFileSync(preload, SIGNAL_AFTER_SPAWN_PRELOAD)
    const { exit } = launchSupervisor(
      { sigtermGraceMs: 300 },
      { ORCA_TEST_PROVIDER_PID_FILE: pidFile },
      { command: process.execPath, args: ['-e', 'setInterval(() => {}, 60000)'] },
      ['--require', preload]
    )

    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM' })
    const provider = Number(readFileSync(pidFile, 'utf8'))
    recordedPids.add(provider)
    expect(await waitFor(() => !alive(provider), 3_000)).toBe(true)
  })

  it('never spawns the provider when its owner is not its parent at start', async () => {
    const dir = tempDir()
    const marker = join(dir, 'provider-spawned')
    const preload = join(dir, 'record-spawn.js')
    writeFileSync(
      preload,
      String.raw`
        const childProcess = require('node:child_process')
        const spawn = childProcess.spawn
        childProcess.spawn = (...args) => {
          require('node:fs').writeFileSync(process.env.ORCA_TEST_PROVIDER_PID_FILE, 'spawned')
          return spawn(...args)
        }
      `
    )
    const { exit } = launchSupervisor(
      { ownerPid: process.pid === 1 ? 2 : 1 },
      { ORCA_TEST_PROVIDER_PID_FILE: marker },
      { command: 'touch', args: [join(dir, 'provider-started')] },
      ['--require', preload]
    )

    await expect(exit).resolves.toEqual({ code: 1, signal: null })
    expect(existsSync(marker)).toBe(false)
  })

  it.each([
    ['', {}],
    // Output after the owner's death meets a closed pipe, which must not end the supervisor first.
    [' while the provider is writing output', { ORCA_TEST_PROVIDER_STREAMS_OUTPUT: '1' }]
  ])('reaps the provider group when its owner dies%s', async (_, env) => {
    const graceMs = 300
    const { owner, pids } = await launchUnderOwner({ sigtermGraceMs: graceMs }, env)

    const killedAt = Date.now()
    owner.kill('SIGKILL')

    expect(await waitFor(() => !alive(-pids.provider), 3_000)).toBe(true)
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(graceMs)
    expect(await waitFor(() => !alive(pids.supervisor), 3_000)).toBe(true)
    expect(alive(pids.grandchild)).toBe(false)
  })

  it('gives a session closed by its stdin end that EOF and grace when its owner dies', async () => {
    const dir = tempDir()
    const signalFile = join(dir, 'provider-signal')
    const flushFile = join(dir, 'provider-flushed')
    const { owner, pids } = await launchUnderOwner(
      { closeRequest: 'stdin-end' },
      { ORCA_TEST_PROVIDER_SIGNAL_FILE: signalFile, ORCA_TEST_PROVIDER_FLUSH_FILE: flushFile },
      { script: FLUSHES_ON_STDIN_END_PROVIDER, pids: ['provider'] }
    )

    owner.kill('SIGKILL')

    expect(await waitFor(() => !alive(pids.provider), PROVIDER_STDIN_END_GRACE_MS)).toBe(true)
    expect(await waitFor(() => !alive(pids.supervisor), 3_000)).toBe(true)
    expect(existsSync(flushFile)).toBe(true)
    expect(existsSync(signalFile)).toBe(false)
  })

  describe('one-shot lifetime', () => {
    it('lets a one-shot answer after its stdin ends and relays its exit code', async () => {
      const signalFile = join(tempDir(), 'provider-signal')
      const { supervisor, exit } = launchSupervisor(
        { lifetime: 'one-shot', stdinEndGraceMs: 100 },
        {
          ORCA_TEST_PROVIDER_SIGNAL_FILE: signalFile,
          ORCA_TEST_PROVIDER_ANSWER_DELAY_MS: '250'
        },
        { command: process.execPath, args: ['-e', ONE_SHOT_PROVIDER] }
      )
      let stdout = ''
      supervisor.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()))

      supervisor.stdin!.end('request')

      await expect(exit).resolves.toEqual({ code: 3, signal: null })
      expect(stdout).toBe('ok')
      expect(existsSync(signalFile)).toBe(false)
    })

    it.each([
      ['dies', 'SIGKILL', {}],
      ['quits cleanly', 'SIGUSR2', { ORCA_TEST_OWNER_QUITS_CLEANLY: '1' }]
    ] as const)(
      'reaps a one-shot that ignores its stdin end when its owner %s',
      async (_, signal, env) => {
        const stdinEndGraceMs = 100
        const { owner, pids } = await launchUnderOwner(
          { lifetime: 'one-shot', stdinEndGraceMs, sigtermGraceMs: 300 },
          { ORCA_TEST_OWNER_ENDS_STDIN: '1', ...env }
        )
        // Past the session grace: a stdin end alone must not have stopped it.
        await new Promise((resolve) => setTimeout(resolve, stdinEndGraceMs + 150))
        expect(alive(-pids.provider)).toBe(true)

        owner.kill(signal)

        expect(await waitFor(() => !alive(-pids.provider), PROVIDER_SUPERVISOR_MAX_STOP_MS)).toBe(
          true
        )
        expect(await waitFor(() => !alive(pids.supervisor), 3_000)).toBe(true)
        expect(alive(pids.grandchild)).toBe(false)
      }
    )

    it('keeps the user Node options from the supervisor and hands them to the provider', async () => {
      const nodeOptions = `--require ${join(tempDir(), 'missing-preload.js')}`
      const { supervisor, exit } = launchSupervisor(
        { lifetime: 'one-shot' },
        { NODE_OPTIONS: nodeOptions },
        { command: '/bin/sh', args: ['-c', 'printf %s "$NODE_OPTIONS"'] }
      )
      let stdout = ''
      supervisor.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      supervisor.stdin!.end()

      await expect(exit).resolves.toEqual({ code: 0, signal: null })
      expect(stdout).toBe(nodeOptions)
    })

    it('reports a spawn that failed without a pid through the marked line', async () => {
      const preload = join(tempDir(), 'spawn-without-pid.js')
      writeFileSync(preload, SPAWN_WITHOUT_PID_PRELOAD)
      const { supervisor, exit } = launchSupervisor(
        { lifetime: 'one-shot' },
        {},
        { command: '/opt/agent', args: [] },
        ['--require', preload],
        'pipe'
      )
      let stderr = ''
      supervisor.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      supervisor.stdin!.end()

      await expect(exit).resolves.toEqual({ code: 127, signal: null })
      expect(supervisedProviderSpawnFailure(127, stderr)).toMatchObject({
        thrown: false,
        error: { code: 'EMFILE', message: 'spawn /opt/agent EMFILE' }
      })
    })

    it('relays all of the provider output to a slow owner before exiting', async () => {
      const bytes = 4 * 1024 * 1024
      const { supervisor, exit } = launchSupervisor(
        { lifetime: 'one-shot' },
        {},
        {
          command: process.execPath,
          args: ['-e', `process.stdout.write('x'.repeat(${bytes})); process.exitCode = 3`]
        }
      )
      let received = 0
      supervisor.stdout!.on('data', (chunk: Buffer) => {
        received += chunk.byteLength
        supervisor.stdout!.pause()
        setTimeout(() => supervisor.stdout!.resume(), 5)
      })
      const closed = new Promise((resolve) => supervisor.once('close', resolve))
      supervisor.stdin!.end()

      await expect(exit).resolves.toEqual({ code: 3, signal: null })
      await closed
      expect(received).toBe(bytes)
    })
  })
})
