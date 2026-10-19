import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
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
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>
}

/** A child that answers initialize and then nothing; it exits only on `exitsOn`. */
function fakeChild(exitsOn: NodeJS.Signals | null): FakeChild {
  const child: FakeChild = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal?: NodeJS.Signals) => {
      if (signal === exitsOn) {
        child.emit('exit', null, signal)
        child.emit('close', null, signal)
      }
      return true
    })
  })
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
  it('SIGTERMs a supervised session at its deadline instead of waiting out its stdin grace', async () => {
    vi.useFakeTimers()
    const child = fakeChild('SIGTERM')
    let stdinEnded = false
    child.stdin.on('finish', () => (stdinEnded = true))

    const outcome = startWedgedSession(child, 'darwin')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(stdinEnded).toBe(true)
    expect(await outcome).toBeInstanceOf(CodexAppServerTimeoutError)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
    expect(killCodexAppServerProcessTree).not.toHaveBeenCalled()
  })

  it('tears a supervised session down only once the supervisor has had its full stop time', async () => {
    vi.useFakeTimers()
    const child = fakeChild(null)

    const outcome = startWedgedSession(child, 'linux')
    await vi.advanceTimersByTimeAsync(1_000 + PROVIDER_SUPERVISOR_MAX_STOP_MS - 1)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(terminateProviderProcessTree).toHaveBeenCalledWith(child, {
      site: 'codex-app-server-session',
      platform: 'linux'
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await outcome).toBeInstanceOf(CodexAppServerTimeoutError)
    // The session's only own signal is the deadline SIGTERM; only the teardown forces.
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(killCodexAppServerProcessTree).not.toHaveBeenCalled()
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
    // The shared close's Windows teardown (taskkill of the tree), as the Codex connection's.
    expect(terminateProviderProcessTree).toHaveBeenCalledWith(child, {
      site: 'codex-app-server-session',
      platform: 'win32'
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(await outcome).toBeInstanceOf(CodexAppServerTimeoutError)
    // The session sends no signal of its own on Windows (a SIGTERM there is TerminateProcess);
    // the teardowns, mocked here, own the kill.
    expect(child.kill).not.toHaveBeenCalled()
    expect(killCodexAppServerProcessTree).toHaveBeenCalledTimes(1)
  })
})
