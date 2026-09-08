import { beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { CodexStateThreadMetadata } from './session-scanner-codex-state-threads'
import type { SessionFileCandidate } from './session-scanner-types'

const readCodexSessionIndexTitle = vi.fn<() => Promise<string | null>>()
const readCodexStateThreadMetadata = vi.fn<() => Promise<CodexStateThreadMetadata | null>>()

vi.mock('./session-scanner-codex-title-index', () => ({
  readCodexSessionIndexTitle: () => readCodexSessionIndexTitle()
}))
vi.mock('./session-scanner-codex-state-threads', () => ({
  readCodexStateThreadMetadata: () => readCodexStateThreadMetadata()
}))

const { refreshCachedCodexMetadata } = await import('./session-scanner-codex-cached-metadata')

type CachedMetadata = Pick<AiVaultSession, 'sessionId' | 'title' | 'cwd' | 'branch' | 'updatedAt'>

const CANDIDATE: SessionFileCandidate = {
  agent: 'codex',
  file: {
    path: '/codex/sessions/rollout-2026-09-07T00-00-00-ses_meta.jsonl',
    mtimeMs: 1_777_634_000_000,
    modifiedAt: '2026-09-07T00:00:00.000Z'
  },
  codexHome: '/codex'
}

function cached(overrides: Partial<CachedMetadata> = {}): CachedMetadata {
  return {
    sessionId: 'ses_meta',
    title: 'Ballast planning',
    cwd: '/repo',
    branch: 'main',
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  readCodexSessionIndexTitle.mockResolvedValue(null)
  readCodexStateThreadMetadata.mockResolvedValue(null)
})

it('returns the same reference when the state DB completes nothing', async () => {
  // A detached-HEAD session has no branch anywhere, so the merge is a no-op and
  // must not look like a change to callers that key an index write on identity.
  const session = cached({ branch: null })
  readCodexStateThreadMetadata.mockResolvedValue({
    title: null,
    cwd: '/repo',
    branch: null,
    updatedAt: '2026-09-07T00:00:00.000Z'
  })
  await expect(refreshCachedCodexMetadata(CANDIDATE, session)).resolves.toBe(session)
})

it('returns the same reference when every field is already present', async () => {
  const session = cached()
  await expect(refreshCachedCodexMetadata(CANDIDATE, session)).resolves.toBe(session)
  expect(readCodexStateThreadMetadata).not.toHaveBeenCalled()
})

it('fills a missing field from the state DB', async () => {
  const session = cached({ cwd: null, branch: null })
  readCodexStateThreadMetadata.mockResolvedValue({
    title: null,
    cwd: '/repo/worktree',
    branch: null,
    updatedAt: null
  })
  const refreshed = await refreshCachedCodexMetadata(CANDIDATE, session)
  expect(refreshed).not.toBe(session)
  expect(refreshed.cwd).toBe('/repo/worktree')
  expect(refreshed.branch).toBeNull()
})
