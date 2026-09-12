import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, readFileMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  spawn: childSpawnMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock
}))

vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { probeCodexAuthPresence } from './codex-auth-presence'

function makeDisposable() {
  return { dispose: vi.fn() }
}

function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const exitNow = (): void => {
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  }
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(exitNow) })
  child.exitCode = null
  child.kill = vi.fn(() => {
    exitNow()
    return true
  })
  return child
}

function makePtyTerm() {
  return {
    onData: vi.fn(() => makeDisposable()),
    onExit: vi.fn(() => makeDisposable()),
    write: vi.fn(),
    kill: vi.fn()
  }
}

function spawnEnoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('spawn codex ENOENT')
  error.code = 'ENOENT'
  return error
}

// STA-3445: `unavailable` is the UI's "provider not set up" signal — it hides the
// chip and feeds the status bar's "Connect an account" empty-state CTA. The auth
// gate runs before either probe spawns, so every failure below is reported about
// a Codex sign-in Orca already proved exists on disk.
describe('fetchCodexRateLimits with a proven Codex sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    vi.mocked(probeCodexAuthPresence).mockResolvedValue('present')
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports an unrunnable RPC probe as a failed reading, not an unconfigured provider', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({ allowPtyFallback: false })
    await vi.advanceTimersByTimeAsync(0)
    rpcChild.emit('error', spawnEnoent())
    await vi.advanceTimersByTimeAsync(0)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Codex CLI not found'
    })
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })

  it('reports an unrunnable PTY fallback as a failed reading, not an unconfigured provider', async () => {
    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockImplementation(() => {
      throw spawnEnoent()
    })

    const resultPromise = fetchCodexRateLimits()
    await vi.advanceTimersByTimeAsync(0)

    await expect(resultPromise).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Codex CLI not found'
    })
  })

  it('still reports a genuinely signed-out Codex as unavailable', async () => {
    vi.mocked(probeCodexAuthPresence).mockResolvedValue('absent')
    ptySpawnMock.mockReturnValue(makePtyTerm())

    await expect(fetchCodexRateLimits()).resolves.toMatchObject({
      provider: 'codex',
      status: 'unavailable',
      error: 'Codex not signed in'
    })
    expect(childSpawnMock).not.toHaveBeenCalled()
    expect(ptySpawnMock).not.toHaveBeenCalled()
  })
})
