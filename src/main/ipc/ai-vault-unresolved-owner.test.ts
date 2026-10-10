/**
 * #18097: conflicting owner publications leave a worktree on the `runtime:unresolved-owner`
 * sentinel. It parses as a runtime host, but no environment has that id, so AI Vault must answer
 * it as unavailable instead of dialing a paired runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  scanLocalSessions: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  requestActiveSshAiVaultSessionTitles: vi.fn()
}))

vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn() } }))

vi.mock('../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: mocks.scanLocalSessions
}))

vi.mock('../wsl', () => ({
  listRunningWslDistrosAsync: vi.fn().mockResolvedValue([]),
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  hasCachedWslDistros: vi.fn(() => false)
}))

vi.mock('./ssh', () => ({
  getActiveSshAiVaultHostInfo: vi.fn(),
  getActiveSshAiVaultHostInfos: vi.fn(() => []),
  requestActiveSshAiVaultSessionList: vi.fn(),
  requestActiveSshAiVaultSessionTitles: mocks.requestActiveSshAiVaultSessionTitles
}))

const { _internals, registerAiVaultHandlers } = await import('./ai-vault')
const { resolveAiVaultSessionTitlesByHost } = await import('./ai-vault-session-title-routing')
const { prepareAiVaultSessionResume } = await import('./ai-vault-resume')

const SENTINEL = 'runtime:unresolved-owner'

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
})

describe('AI Vault never routes the unresolved-owner sentinel (#18097)', () => {
  it('answers a list with a host issue and no runtime or local scan', async () => {
    registerAiVaultHandlers({ scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions })

    const result = await _internals.listAiVaultSessions({ executionHostScope: SENTINEL })

    expect(mocks.scanRuntimeAiVaultSessions).not.toHaveBeenCalled()
    expect(mocks.scanLocalSessions).not.toHaveBeenCalled()
    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        message: 'Agent Session History is not available for this execution host.'
      })
    ])
  })

  it('settles titles empty without calling the runtime resolver', async () => {
    const resolveRuntime = vi.fn()

    await expect(
      resolveAiVaultSessionTitlesByHost(
        { executionHostScope: SENTINEL, requests: [] },
        resolveRuntime
      )
    ).resolves.toEqual({ titles: [] })
    expect(resolveRuntime).not.toHaveBeenCalled()
  })

  it('refuses a resume instead of preparing it on a runtime or locally', async () => {
    const prepareSessionResume = vi.fn()
    const prepareRuntimeSessionResume = vi.fn()

    await expect(
      prepareAiVaultSessionResume(
        {
          agent: 'codex',
          filePath: '/managed/sessions/rollout-a.jsonl',
          codexHome: '/managed',
          executionHostId: SENTINEL
        },
        { prepareSessionResume, prepareRuntimeSessionResume }
      )
    ).rejects.toThrow('The session host is unavailable')
    expect(prepareRuntimeSessionResume).not.toHaveBeenCalled()
    expect(prepareSessionResume).not.toHaveBeenCalled()
  })
})
