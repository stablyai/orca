import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  childSpawnMock,
  readFileMock,
  resolveCodexCommandMock,
  ptySpawnMock,
  isBackfillPendingMock,
  startBackfillRecoveryMock
} = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn(),
  isBackfillPendingMock: vi.fn(() => false),
  startBackfillRecoveryMock: vi.fn(() => Promise.resolve(null))
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

vi.mock('../codex/codex-state-db', () => ({
  isCodexStateDbBackfillPending: isBackfillPendingMock
}))

vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: startBackfillRecoveryMock
}))

// Default to signed-in so the probe paths under test still run.
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { makePtyTerm, makeRpcChild } from './codex-fetcher.test-fixtures'

// Why its own file: `codex-fetcher.test.ts` is at the max-lines ceiling, so this suite imports the
// shared probe doubles rather than growing it.
describe('Codex probe proxy environment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    readFileMock.mockRejectedValue(new Error('no auth fixture'))
    isBackfillPendingMock.mockReturnValue(false)
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Why: the probe is spawned with the app process env, and on macOS a Dock-launched app has no
  // shell proxy vars, so a configured Orca proxy never reached it (mirrors claude-pty.ts). #19755.
  it('injects the configured proxy into the codex RPC probe env', async () => {
    const rpcChild = makeRpcChild()
    childSpawnMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({
      allowPtyFallback: false,
      networkProxySettings: { httpProxyUrl: 'http://127.0.0.1:7890' }
    })
    await vi.advanceTimersByTimeAsync(0)

    // Why: capture, then settle before asserting. The probe holds the codex-home process lock
    // until it resolves, so asserting first would leave the lock held and hang later tests.
    const spawnEnv = childSpawnMock.mock.calls[0]?.[2]?.env as Record<string, string>

    rpcChild.emit('close')
    await resultPromise

    expect(spawnEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(spawnEnv.HTTP_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('injects the configured proxy into the codex PTY fallback env', async () => {
    const term = makePtyTerm()
    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
    ptySpawnMock.mockReturnValue(term)

    const resultPromise = fetchCodexRateLimits({
      networkProxySettings: { httpProxyUrl: 'http://127.0.0.1:7890' }
    })
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv = ptySpawnMock.mock.calls[0]?.[2]?.env as Record<string, string>

    term.emitExit()
    await resultPromise

    expect(spawnEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(spawnEnv.HTTP_PROXY).toBe('http://127.0.0.1:7890')
  })

  // Why: a proxy URL may embed credentials (it is a protected secret at rest), and wsl.exe
  // command lines are visible to local processes — so the values must cross via WSLENV names,
  // never serialized into the command (CodeRabbit CWE-200 on #19931).
  it('keeps proxy credentials out of the WSL command line and crosses them via WSLENV', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const rpcChild = makeRpcChild()
      childSpawnMock.mockReturnValue(rpcChild)

      const resultPromise = fetchCodexRateLimits({
        allowPtyFallback: false,
        codexHomePath: String.raw`\\wsl.localhost\Ubuntu\home\alice`,
        networkProxySettings: { httpProxyUrl: 'http://user:pass@127.0.0.1:7890' }
      })
      await vi.advanceTimersByTimeAsync(0)

      const [spawnCmd, spawnArgs, spawnOptions] = childSpawnMock.mock.calls[0] ?? []
      expect(spawnCmd).toBe('wsl.exe')
      const commandText = Array.isArray(spawnArgs) ? (spawnArgs as string[]).join(' ') : ''
      expect(commandText).not.toContain('user:pass@127.0.0.1:7890')
      const spawnEnv = (spawnOptions as { env?: Record<string, string> })?.env ?? {}
      expect(spawnEnv.HTTPS_PROXY).toBe('http://user:pass@127.0.0.1:7890')
      expect(spawnEnv.WSLENV ?? '').toContain('HTTPS_PROXY')

      rpcChild.emit('close')
      await resultPromise
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
  })
})
