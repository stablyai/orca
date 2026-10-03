import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS,
  supervisedPosixLaunch,
  type ProviderSupervisorOptions
} from './provider-process-supervisor'

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

// Exits the moment its stdin ends, as Codex does on a normal close.
const EXITS_ON_STDIN_END_PROVIDER = String.raw`
  process.stdin.on('end', () => process.exit(0)).resume()
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

// Stands in for Orca: launches the supervisor as its own child, then can be killed outright. A
// second child holds the supervisor's stdin open, so only the parent-death watch can notice.
// A clean-quit owner has no holder and exits normally on SIGUSR2, the way Orca quits.
const OWNER = String.raw`
  const { spawn } = require('node:child_process')
  const quitsCleanly = Boolean(process.env.ORCA_TEST_OWNER_QUITS_CLEANLY)
  if (quitsCleanly) process.on('SIGUSR2', () => process.exit(0))
  const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
  spec.ownerPid = process.pid
  const supervisor = spawn(process.execPath, ['-e', process.env.ORCA_TEST_SUPERVISOR_SCRIPT], {
    env: { ...process.env, ORCA_PROVIDER_SUPERVISOR_SPEC: Buffer.from(JSON.stringify(spec)).toString('base64') },
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true
  })
  const holder = quitsCleanly
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
  nodeArgs: string[] = []
): { supervisor: ChildProcess; exit: Promise<{ code: number | null; signal: string | null }> } {
  const launch = supervisedPosixLaunch(provider, { ...process.env, ...env }, options)
  const supervisor = spawn(launch.command, [...nodeArgs, ...launch.args], {
    env: launch.env,
    stdio: ['pipe', 'pipe', 'ignore'],
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
  env: Record<string, string> = {}
): Promise<{ owner: ChildProcess; pids: Record<string, number> }> {
  const launch = supervisedPosixLaunch(
    { command: process.execPath, args: ['-e', PROVIDER] },
    { ...process.env, ...env },
    options
  )
  const owner = spawn(process.execPath, ['-e', OWNER], {
    env: { ...launch.env, ORCA_TEST_SUPERVISOR_SCRIPT: POSIX_PROVIDER_SUPERVISOR_SCRIPT },
    stdio: ['ignore', 'pipe', 'ignore']
  })
  recordedPids.add(owner.pid!)
  const pids = await readPids(owner, ['supervisor', 'provider', 'grandchild'])
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

  it('escalates a SIGTERM-ignoring provider to SIGKILL after the grace from the spec', async () => {
    const graceMs = 200
    const { supervisor, exit } = launchSupervisor(
      { sigtermGraceMs: graceMs },
      { ORCA_TEST_PROVIDER_IGNORES_SIGTERM: '1' }
    )
    const { provider, grandchild } = await readPids(supervisor, ['provider', 'grandchild'])

    const signalledAt = Date.now()
    supervisor.kill('SIGTERM')
    const exited = await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))])

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
})
