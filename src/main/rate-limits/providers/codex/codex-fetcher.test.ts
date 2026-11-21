import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  blockedWslDistroForPath: vi.fn(),
  spawnProcessOnWorkerThread: vi.fn(),
  isCodexStateDbBackfillPending: vi.fn(() => false)
}))

vi.mock('../../../wsl/filesystem/wsl-unc-access-gate', () => ({
  blockedWslDistroForPath: mocks.blockedWslDistroForPath
}))
vi.mock('../../../worker-thread-child-process/worker-thread-child-process', () => ({
  spawnProcessOnWorkerThread: mocks.spawnProcessOnWorkerThread
}))
vi.mock('../../../codex/history/index/codex-state-db', () => ({
  isCodexStateDbBackfillPending: mocks.isCodexStateDbBackfillPending
}))
vi.mock('../../../codex/history/index/codex-state-db-backfill-recovery', () => ({
  hasCodexStateDbBackfillRecoveryGivenUp: () => false,
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))
vi.mock('../../../codex-cli/codex-home-process-lock', () => ({
  resolveCodexHomeProcessLockKey: () => 'home',
  withCodexHomeProcessLock: (_key: string, run: () => Promise<unknown>) => run()
}))
vi.mock('../../../network/http-client', () => ({ getMainHttpClient: vi.fn() }))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: async () => 'present' }))
vi.mock('./codex-backend-usage-client', () => ({
  fetchCodexRateLimitsViaBackend: async () => null,
  supplementCodexUsageWindows: async (limits: unknown) => limits
}))

import { fetchCodexRateLimits } from './codex-fetcher'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex'
const STOPPED = "WSL distro 'Ubuntu' is not running. Open a terminal in it to start it."
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.clearAllMocks()
})

describe('Codex usage for a WSL home whose distro stops mid-poll (E9)', () => {
  it('reads no state DB over UNC once the distro stopped during the auth and HTTP reads', async () => {
    mocks.blockedWslDistroForPath.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })

    const result = await fetchCodexRateLimits({ codexHomePath: WSL_HOME })

    expect(result.error).toBe(STOPPED)
    expect(mocks.isCodexStateDbBackfillPending).not.toHaveBeenCalled()
    expect(mocks.spawnProcessOnWorkerThread).not.toHaveBeenCalled()
  })

  it('spawns no wsl.exe probe once the distro stopped while waiting on the process lock', async () => {
    mocks.blockedWslDistroForPath
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })

    const result = await fetchCodexRateLimits({ codexHomePath: WSL_HOME })

    expect(result.error).toBe(STOPPED)
    expect(mocks.spawnProcessOnWorkerThread).not.toHaveBeenCalled()
  })
})
