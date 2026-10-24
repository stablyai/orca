import type * as ProviderLedgerModule from '../provider-process/provider-process-ledger'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPosixProcessRow } from '../provider-process/provider-process-row-read'
import { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import type * as ProcessTreeKill from './codex-app-server-process-tree-kill'
import {
  killCodexAppServerProcessTree,
  type CodexAppServerSpawn
} from './codex-app-server-process-tree-kill'
import { CodexAppServerTimeoutError, runCodexAppServerSession } from './codex-app-server-session'

vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn(async () => 'exited' as const)
}))
vi.mock('./codex-app-server-process-tree-kill', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTreeKill>()),
  killCodexAppServerProcessTree: vi.fn()
}))

type FakeChild = EventEmitter & {
  pid: number
  exitCode: number | null
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>
}

/** A child that answers initialize and then nothing; it exits only on `exitsOn`. */
function fakeChild(exitsOn: NodeJS.Signals | null): FakeChild {
  const child: FakeChild = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    exitCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal?: NodeJS.Signals) => {
      if (signal === exitsOn) {
        child.exitCode = 0
        child.emit('exit', null, signal)
        child.emit('close', null, signal)
      }
      return true
    })
  })
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== -child.pid) {
      throw new Error('Unexpected fixture signal')
    }
    if (child.exitCode !== null) {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      child.kill(signal)
    }
    return true
  })
  vi.mocked(readPosixProcessRow).mockImplementation(async () =>
    child.exitCode === null
      ? {
          pid: child.pid,
          pgid: child.pid,
          ppid: process.pid,
          startedAt: 'fixture',
          startResolution: 'clock-tick'
        }
      : null
  )
  child.stdin.on('data', (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString())
    if (message.method === 'initialize') {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`)
    }
  })
  return child
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

function startWedgedSession(child: FakeChild, platform: NodeJS.Platform): Promise<unknown> {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session reads only pid, stdio, kill and the exit/close/error events, which the fake implements.
  const spawnImpl: CodexAppServerSpawn = () => child as never
  return runCodexAppServerSession(
    { command: '/bin/codex', cliPath: null, args: ['app-server'], timeoutMs: 1_000 },
    () => new Promise<never>(() => {}),
    spawnImpl
  ).catch((error: unknown) => error)
}

describe('runCodexAppServerSession stop', () => {
  it('stops a Windows plugin tree while its root and stdin still live', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = fakeChild(null)
    vi.mocked(terminateProviderProcessTree).mockImplementationOnce(async () => {
      expect(child.stdin.writableEnded).toBe(false)
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
      return 'exited'
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements the session's pid, stdio, kill and lifecycle events.
    const spawnImpl: CodexAppServerSpawn = () => child as never
    await runCodexAppServerSession(
      {
        command: '/bin/codex',
        cliPath: null,
        args: ['app-server'],
        timeoutMs: 1_000,
        treeKillOnFinish: true
      },
      async () => null,
      spawnImpl
    )
    expect(terminateProviderProcessTree).toHaveBeenCalledExactlyOnceWith(child, {
      site: 'codex-app-server-session',
      platform: 'win32'
    })
  })

  it('ends stdin at its deadline and signals the owned group after its grace', async () => {
    vi.useFakeTimers()
    const child = fakeChild('SIGTERM')
    let stdinEnded = false
    child.stdin.on('finish', () => (stdinEnded = true))

    const outcome = startWedgedSession(child, 'darwin')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.stdin.writableEnded).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(stdinEnded).toBe(true)
    expect(await outcome).toBeInstanceOf(CodexAppServerTimeoutError)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
    expect(killCodexAppServerProcessTree).not.toHaveBeenCalled()
  })

  it('escalates a TERM-ignoring owned group and joins its actual exit', async () => {
    vi.useFakeTimers()
    const child = fakeChild('SIGKILL')
    const outcome = startWedgedSession(child, 'linux')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    await expect(outcome).resolves.toBeInstanceOf(CodexAppServerTimeoutError)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
  })

  it('keeps the Windows deadline kill and its 1.5 s close wait', async () => {
    vi.useFakeTimers()
    const child = fakeChild(null)

    const outcome = startWedgedSession(child, 'win32')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(killCodexAppServerProcessTree).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(terminateProviderProcessTree).toHaveBeenCalledWith(child, {
      site: 'codex-app-server-session',
      platform: 'win32'
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(await outcome).toBeInstanceOf(CodexAppServerTimeoutError)
    // Windows SIGTERM is TerminateProcess; the mocked teardowns own termination.
    expect(child.kill).not.toHaveBeenCalled()
    expect(killCodexAppServerProcessTree).toHaveBeenCalledTimes(1)
  })
})

vi.mock('../provider-process/provider-process-ledger', async (original) => ({
  ...(await original<typeof ProviderLedgerModule>()),
  recordProviderLaunch: () => ({
    capture: async () => {},
    retire: async () => {},
    members: () => [{ pid: 9_999_999, pgid: 9_999_999, startedAt: 'fixture' }]
  })
}))
vi.mock('../provider-process/provider-process-row-read', () => ({ readPosixProcessRow: vi.fn() }))
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))
