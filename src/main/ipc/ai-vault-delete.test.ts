import { join, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CLAUDE_EXTRA = join(sep, 'tmp', 'orca-test-claude-work', 'projects')

const mocks = vi.hoisted(() => ({
  deleteAiVaultSessionFile: vi.fn(),
  invalidateAiVaultSessionListCache: vi.fn(),
  invalidateSessionParseCacheEntry: vi.fn(),
  invalidateAiVaultBackgroundCache: vi.fn(async () => undefined),
  additionalClaudeProjectsDirs: vi.fn(() => [CLAUDE_EXTRA]),
  configuredAdditionalCodexHomePaths: vi.fn(() => []),
  getAiVaultWslHomeDirs: vi.fn(async () => [] as string[]),
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

vi.mock('../ai-vault/session-delete', () => ({
  deleteAiVaultSessionFile: mocks.deleteAiVaultSessionFile
}))

vi.mock('../ai-vault/session-scanner-parse-cache', () => ({
  invalidateSessionParseCacheEntry: mocks.invalidateSessionParseCacheEntry
}))

vi.mock('../ai-vault/session-scanner-background', () => ({
  invalidateAiVaultBackgroundCache: mocks.invalidateAiVaultBackgroundCache
}))

vi.mock('../ai-vault/cached-session-list', () => ({
  additionalClaudeProjectsDirs: mocks.additionalClaudeProjectsDirs,
  configuredAdditionalClaudeConfigDirs: vi.fn(() => []),
  configuredAdditionalCodexHomePaths: mocks.configuredAdditionalCodexHomePaths,
  getAiVaultWslHomeDirs: mocks.getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache: mocks.invalidateAiVaultSessionListCache
}))

vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: mocks.filterPathsToRunningWslDistrosAsync
}))

// Dynamic import so the vi.mock seams above apply before the module loads.
const { deleteAiVaultSession } = await import('./ai-vault-delete')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deleteAiVaultSession extra scan roots', () => {
  it('threads Claude and Codex extra roots into the delete executor', async () => {
    mocks.deleteAiVaultSessionFile.mockResolvedValue({ outcome: 'deleted' })

    await deleteAiVaultSession(
      { agent: 'claude', sessionId: 'sess-9', filePath: '/tmp/x.jsonl', executionHostId: 'local' },
      { invalidateMultiHostListCache: vi.fn() }
    )

    expect(mocks.deleteAiVaultSessionFile).toHaveBeenCalledWith(
      expect.objectContaining({
        rootOptions: {
          additionalClaudeProjectsDirs: [CLAUDE_EXTRA],
          additionalCodexSessionsDirs: []
        }
      })
    )
  })
})
