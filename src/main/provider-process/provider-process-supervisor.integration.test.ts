import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVIDER_SIGTERM_GRACE_MS,
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

// Exits the moment its stdin ends, as Codex does on a normal close.
const EXITS_ON_STDIN_END_PROVIDER = String.raw`
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

// Ignores stdin end and SIGTERM, recording when SIGTERM arrived, so only SIGKILL ends it.
const RECORDS_SIGTERM_PROVIDER = String.raw`
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

// Stands in for Orca: launches the supervisor as its own child, then can be killed outright. A
// second child holds the supervisor's stdin open, so only the parent-death watch can notice.
// A clean-quit owner has no holder and exits normally on SIGUSR2, the way Orca quits. A one-shot
// owner ends the supervisor's stdin at once, as Orca does after writing a one-shot's request.
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
        // Later output is not pids; the stream keeps flowing without a listener.
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

  it('kills the rest of a one-shot group at once when the provider exits on a stop', async () => {
    const { supervisor, exit } = launchSupervisor({ lifetime: 'one-shot' })
    const { provider, grandchild } = await readPids(supervisor, ['provider', 'grandchild'])

    const signalledAt = Date.now()
    supervisor.kill('SIGTERM')

    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM' })
    // The grandchild ignores SIGTERM; waiting out the 3 s grace for it would be the old cost.
    expect(Date.now() - signalledAt).toBeLessThan(PROVIDER_SIGTERM_GRACE_MS / 3)
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

  it('escalates a SIGTERM-ignoring provider to SIGKILL after the grace from the spec', async () => {
    const graceMs = 200
    const { supervisor, exit } = launchSupervisor(
      { sigtermGraceMs: graceMs },
      { ORCA_TEST_PROVIDER_IGNORES_SIGTERM: '1' }
    )
    const { provider, grandchild } = await readPids(supervisor, ['provider', 'grandchild'])

    const signalledAt = Date.now()
    supervisor.kill('SIGTERM')
    let exitTimeout: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      exit,
      new Promise((resolve) => {
        exitTimeout = setTimeout(resolve, 5_000)
      })
    ]).finally(() => clearTimeout(exitTimeout))

    expect(exited).toEqual({ code: null, signal: 'SIGTERM' })
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(graceMs)
    expect(Date.now() - signalledAt).toBeLessThan(PROVIDER_SIGTERM_GRACE_MS)
    expect(alive(provider)).toBe(false)
    expect(alive(grandchild)).toBe(false)
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
    const marker = join(tempDir(), 'provider-started')
    const { exit } = launchSupervisor(
      { ownerPid: process.pid === 1 ? 2 : 1 },
      {},
      { command: 'touch', args: [marker] }
    )

    await expect(exit).resolves.toEqual({ code: 1, signal: null })
    await new Promise((resolve) => setTimeout(resolve, 200))
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
    // The grandchild ignores SIGTERM, so the group lasts until the grace ends in SIGKILL.
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(graceMs)
    expect(await waitFor(() => !alive(pids.supervisor), 3_000)).toBe(true)
    expect(alive(pids.grandchild)).toBe(false)
  })

  it('closes a provider that exits on stdin end without waiting out any grace', async () => {
    const { supervisor, exit } = launchSupervisor(
      {},
      {},
      {
        command: process.execPath,
        args: ['-e', EXITS_ON_STDIN_END_PROVIDER]
      }
    )
    const { provider } = await readPids(supervisor, ['provider'])

    const endedAt = Date.now()
    supervisor.stdin!.end()

    await expect(exit).resolves.toEqual({ code: 0, signal: null })
    expect(Date.now() - endedAt).toBeLessThan(PROVIDER_STDIN_END_GRACE_MS)
    expect(alive(provider)).toBe(false)
  })

  it('gives a provider 1 s after stdin end, then 3 s after SIGTERM before SIGKILL', async () => {
    const signalFile = join(tempDir(), 'provider-sigterm-at')
    const { supervisor, exit } = launchSupervisor(
      {},
      { ORCA_TEST_PROVIDER_SIGNAL_FILE: signalFile },
      { command: process.execPath, args: ['-e', RECORDS_SIGTERM_PROVIDER] }
    )
    const { provider } = await readPids(supervisor, ['provider'])

    const endedAt = Date.now()
    supervisor.stdin!.end()
    const exited = await exit
    const exitedAt = Date.now()
    const signalledAt = Number(readFileSync(signalFile, 'utf8'))

    expect(exited).toEqual({ code: 137, signal: null })
    // Timers may fire a tick early against another process's clock.
    expect(signalledAt - endedAt).toBeGreaterThanOrEqual(1_000 - 20)
    expect(exitedAt - signalledAt).toBeGreaterThanOrEqual(3_000 - 20)
    expect(exitedAt - endedAt).toBeLessThan(PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000)
    expect(alive(provider)).toBe(false)
  })

  it('reaps the provider group and exits when its owner quits cleanly', async () => {
    const { owner, pids } = await launchUnderOwner(
      { sigtermGraceMs: 300 },
      { ORCA_TEST_OWNER_QUITS_CLEANLY: '1' }
    )
    const ownerExit = new Promise((resolve) =>
      owner.once('exit', (code, signal) => resolve({ code, signal }))
    )

    owner.kill('SIGUSR2')

    await expect(ownerExit).resolves.toEqual({ code: 0, signal: null })
    expect(await waitFor(() => !alive(-pids.provider), 3_000)).toBe(true)
    expect(await waitFor(() => !alive(pids.supervisor), 3_000)).toBe(true)
    expect(alive(pids.grandchild)).toBe(false)
  })

  it('asks the provider to stop with SIGTERM when its owner dies', async () => {
    const signalFile = join(tempDir(), 'provider-signal')
    const { owner, pids } = await launchUnderOwner(
      { sigtermGraceMs: 300 },
      { ORCA_TEST_PROVIDER_SIGNAL_FILE: signalFile }
    )

    owner.kill('SIGKILL')

    expect(await waitFor(() => !alive(-pids.provider), 3_000)).toBe(true)
    expect(existsSync(signalFile) && readFileSync(signalFile, 'utf8')).toBe('SIGTERM')
  })

  it('stops a session closed with SIGTERM at once when its owner dies', async () => {
    const signalFile = join(tempDir(), 'provider-sigterm-at')
    const { owner, pids } = await launchUnderOwner(
      { sigtermGraceMs: 200 },
      { ORCA_TEST_PROVIDER_SIGNAL_FILE: signalFile },
      { script: RECORDS_SIGTERM_PROVIDER, pids: ['provider'] }
    )

    const killedAt = Date.now()
    owner.kill('SIGKILL')

    // Non-empty, not just present: a read between create and write would pass any bound.
    const signalledAt = (): number =>
      existsSync(signalFile) ? Number(readFileSync(signalFile, 'utf8')) : 0
    expect(await waitFor(() => signalledAt() > 0, 3_000)).toBe(true)
    // No unwatched stdin-end grace: the owner-death watch's 100 ms poll is the whole delay.
    expect(signalledAt() - killedAt).toBeGreaterThanOrEqual(0)
    expect(signalledAt() - killedAt).toBeLessThan(PROVIDER_STDIN_END_GRACE_MS / 2)
    expect(await waitFor(() => !alive(-pids.provider), 3_000)).toBe(true)
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

  it('stops a stdin-end session that ignores its EOF once the grace after owner death ends', async () => {
    const signalFile = join(tempDir(), 'provider-sigterm-at')
    const stdinEndGraceMs = 400
    const { owner, pids } = await launchUnderOwner(
      { closeRequest: 'stdin-end', stdinEndGraceMs, sigtermGraceMs: 200 },
      { ORCA_TEST_PROVIDER_SIGNAL_FILE: signalFile },
      { script: RECORDS_SIGTERM_PROVIDER, pids: ['provider'] }
    )

    const killedAt = Date.now()
    owner.kill('SIGKILL')

    expect(await waitFor(() => !alive(-pids.provider), 3_000)).toBe(true)
    // Timers may fire a tick early against another process's clock.
    expect(Number(readFileSync(signalFile, 'utf8')) - killedAt).toBeGreaterThanOrEqual(
      stdinEndGraceMs - 20
    )
    expect(await waitFor(() => !alive(pids.supervisor), 3_000)).toBe(true)
  })

  describe('one-shot lifetime', () => {
    it('lets a one-shot answer after its stdin ends and relays its exit code', async () => {
      const signalFile = join(tempDir(), 'provider-signal')
      const { supervisor, exit } = launchSupervisor(
        { lifetime: 'one-shot' },
        {
          ORCA_TEST_PROVIDER_SIGNAL_FILE: signalFile,
          ORCA_TEST_PROVIDER_ANSWER_DELAY_MS: String(PROVIDER_STDIN_END_GRACE_MS * 1.5)
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
        const { owner, pids } = await launchUnderOwner(
          { lifetime: 'one-shot', sigtermGraceMs: 300 },
          { ORCA_TEST_OWNER_ENDS_STDIN: '1', ...env }
        )
        // Past the session grace: a stdin end alone must not have stopped it.
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_STDIN_END_GRACE_MS + 300))
        expect(alive(-pids.provider)).toBe(true)

        owner.kill(signal)

        expect(await waitFor(() => !alive(-pids.provider), PROVIDER_SUPERVISOR_MAX_STOP_MS)).toBe(
          true
        )
        expect(await waitFor(() => !alive(pids.supervisor), 3_000)).toBe(true)
        expect(alive(pids.grandchild)).toBe(false)
      }
    )

    it('escalates a SIGTERM-ignoring one-shot to SIGKILL after the grace from the spec', async () => {
      const graceMs = 200
      const { supervisor, exit } = launchSupervisor(
        { lifetime: 'one-shot', sigtermGraceMs: graceMs },
        { ORCA_TEST_PROVIDER_IGNORES_SIGTERM: '1' }
      )
      const { provider, grandchild } = await readPids(supervisor, ['provider', 'grandchild'])
      supervisor.stdin!.end()

      const signalledAt = Date.now()
      supervisor.kill('SIGTERM')

      await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM' })
      expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(graceMs)
      expect(Date.now() - signalledAt).toBeLessThan(PROVIDER_SIGTERM_GRACE_MS)
      expect(alive(provider)).toBe(false)
      expect(alive(grandchild)).toBe(false)
    })

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

    it('hands the provider a near-cap argv prompt intact', async () => {
      const prompt = 'x'.repeat(110 * 1024)
      const { supervisor, exit } = launchSupervisor(
        { lifetime: 'one-shot' },
        {},
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write(String(process.argv[1].length))', prompt]
        }
      )
      let stdout = ''
      supervisor.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      supervisor.stdin!.end()

      await expect(exit).resolves.toEqual({ code: 0, signal: null })
      expect(stdout).toBe(String(prompt.length))
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
