import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  spawnProcessMock,
  readFileMock,
  resolveCodexCommandMock,
  isBackfillPendingMock,
  startBackfillRecoveryMock
} = vi.hoisted(() => ({
  spawnProcessMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  isBackfillPendingMock: vi.fn(() => false),
  startBackfillRecoveryMock: vi.fn(() => Promise.resolve(null))
}))

vi.mock('../../shared/child-process/run-process', () => ({
  spawnProcess: spawnProcessMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('../codex/codex-state-db', () => ({
  isCodexStateDbBackfillPending: isBackfillPendingMock
}))

vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: startBackfillRecoveryMock
}))

vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(() => 'present')
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { makeRpcChild } from './codex-fetcher.test-fixtures'

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

  // Why: a Dock-launched app has no shell proxy vars, so the configured proxy must be added to
  // the short-lived Codex process explicitly (#19755).
  it('injects the configured proxy into the codex RPC probe env', async () => {
    const rpcChild = makeRpcChild()
    spawnProcessMock.mockReturnValue(rpcChild)

    const resultPromise = fetchCodexRateLimits({
      networkProxySettings: { httpProxyUrl: 'http://127.0.0.1:7890' }
    })
    await vi.advanceTimersByTimeAsync(0)

    const spawnEnv: Record<string, string> = spawnProcessMock.mock.calls[0]?.[0]?.env

    rpcChild.emit('close')
    await resultPromise

    expect(spawnEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(spawnEnv.HTTP_PROXY).toBe('http://127.0.0.1:7890')
  })

  // Why: proxy credentials are protected at rest but command lines are visible to local processes.
  it('keeps proxy credentials out of the WSL command line and crosses them via WSLENV', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const rpcChild = makeRpcChild()
      spawnProcessMock.mockReturnValue(rpcChild)

      const resultPromise = fetchCodexRateLimits({
        codexHomePath: String.raw`\\wsl.localhost\Ubuntu\home\alice`,
        networkProxySettings: { httpProxyUrl: 'http://user:pass@127.0.0.1:7890' }
      })
      await vi.advanceTimersByTimeAsync(0)

      const spawnOptions = spawnProcessMock.mock.calls[0]?.[0]
      expect(spawnOptions?.program).toBe('wsl.exe')
      const commandText = Array.isArray(spawnOptions?.args) ? spawnOptions.args.join(' ') : ''
      expect(commandText).not.toContain('user:pass@127.0.0.1:7890')
      const spawnEnv: Record<string, string> = spawnOptions?.env ?? {}
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
