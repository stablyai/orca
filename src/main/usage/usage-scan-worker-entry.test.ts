import { expect, it, vi } from 'vitest'

const { port, scanOmpUsageFiles } = vi.hoisted(() => {
  const listeners: ((message: unknown) => void)[] = []
  return {
    port: {
      on: (_event: string, listener: (message: unknown) => void) => listeners.push(listener),
      postMessage: vi.fn(),
      deliver: (message: unknown) => listeners.forEach((listener) => listener(message))
    },
    scanOmpUsageFiles: vi.fn()
  }
})

vi.mock('node:worker_threads', () => ({ parentPort: port, threadId: 1 }))
vi.mock('../claude-usage/scanner', () => ({ scanClaudeUsageFiles: vi.fn() }))
vi.mock('../codex-usage/scanner', () => ({ scanCodexUsageFiles: vi.fn() }))
vi.mock('../opencode-usage/scanner', () => ({ scanOpenCodeUsageDatabases: vi.fn() }))
vi.mock('../muse-usage/scanner', () => ({ scanMuseUsageFiles: vi.fn() }))
vi.mock('../muse-usage/persisted-file-normalization', () => ({
  normalizeMuseUsagePersistedFiles: vi.fn()
}))
vi.mock('../opencode-usage/persisted-database-normalization', () => ({
  normalizeOpenCodeUsagePersistedDatabases: vi.fn()
}))
vi.mock('../claude-usage/persisted-source-cache', () => ({
  readClaudeUsageSourceCache: vi.fn(),
  splitClaudeUsageCacheFile: vi.fn(),
  persistClaudeUsageSourceCache: vi.fn()
}))
vi.mock('../omp-usage/scanner', () => ({ scanOmpUsageFiles }))

const WORKTREES = [
  { repoId: 'repo-1', worktreeId: 'wt-1', path: '/repo/worktree', displayName: 'worktree' }
]
const SOURCE_CACHE = {
  path: '/tmp/orca-omp-usage-sources.json',
  schemaVersion: 1,
  worktreeFingerprint: '[]',
  reuse: false
}

it('dispatches an omp scan to the omp scanner and returns its envelope', async () => {
  const sessions = [{ sessionId: 'session-1' }]
  const dailyAggregates = [{ day: '2026-10-30' }]
  scanOmpUsageFiles.mockResolvedValue({ sessions, dailyAggregates })
  // Why dynamic: the entry registers its message handler once at module load, so it must be imported
  // after the worker_threads mock is in place; one request per test file.
  await import('./usage-scan-worker-entry')
  const replied = Promise.withResolvers<unknown>()
  port.postMessage.mockImplementationOnce(replied.resolve)

  port.deliver({
    id: 7,
    operation: 'scan',
    providerId: 'omp',
    worktrees: WORKTREES,
    sourceCache: SOURCE_CACHE
  })

  await expect(replied.promise).resolves.toEqual({
    id: 7,
    ok: true,
    value: {
      operation: 'scan',
      providerId: 'omp',
      sessions,
      dailyAggregates
    }
  })
  expect(scanOmpUsageFiles).toHaveBeenCalledWith(WORKTREES, SOURCE_CACHE)
})
