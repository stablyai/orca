import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listWslDistrosAsync: vi.fn(),
  getWslHomeAsync: vi.fn()
}))

vi.mock('../wsl', () => ({
  listWslDistrosAsync: wslMocks.listWslDistrosAsync,
  getWslHomeAsync: wslMocks.getWslHomeAsync
}))

vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  wslGatedAccess: vi.fn().mockResolvedValue(true)
}))

import { resetWslSessionHomeDirsForTests } from './wsl-session-home-dirs'
import { resolveHostReadableAiVaultTitleRequests } from './session-title-request-paths'

const GUEST_PATH = '/home/ada/.codex/sessions/2026/07/24/rollout-sess.jsonl'
const UNC_PATH =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\2026\\07\\24\\rollout-sess.jsonl'

beforeEach(() => {
  resetWslSessionHomeDirsForTests()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  wslMocks.listWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu'])
  wslMocks.getWslHomeAsync.mockReset().mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\ada')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveHostReadableAiVaultTitleRequests WSL opt-out', () => {
  it('translates a guest path through the distro homes when WSL scanning is on', async () => {
    await expect(
      resolveHostReadableAiVaultTitleRequests(
        [{ agent: 'codex', sessionId: 'sess', transcriptPath: GUEST_PATH }],
        true
      )
    ).resolves.toEqual([{ agent: 'codex', sessionId: 'sess', transcriptPath: UNC_PATH }])
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(1)
  })

  // Why: the scanner child cannot read the store, so the request flag is the
  // only thing standing between a titles batch and a distro boot.
  it('degrades a guest path to id-only without touching wsl.exe when off', async () => {
    await expect(
      resolveHostReadableAiVaultTitleRequests(
        [{ agent: 'codex', sessionId: 'sess', transcriptPath: GUEST_PATH }],
        false
      )
    ).resolves.toEqual([{ agent: 'codex', sessionId: 'sess' }])
    expect(wslMocks.listWslDistrosAsync).not.toHaveBeenCalled()
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })
})
