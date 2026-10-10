import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'

const { readdirMock } = vi.hoisted(() => ({ readdirMock: vi.fn() }))

// Why the module-level mock rather than a temp directory: the defect is a listing that never
// returns — a stalled NFS/SMB share or WSL UNC mount — which no real filesystem reproduces.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readdir: readdirMock
}))

const { ensureRetiredWorktreeNamesBackfilled } = await import('./worktree-name-retirement')
const { RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS } = await import('./worktree-retirement-backfill-scan')

const repo = {
  id: 'repo-a',
  path: '/repos/a',
  displayName: 'a',
  badgeColor: '',
  addedAt: 0
} as Repo
const settings = { workspaceDir: '/workspaces', nestWorkspaces: false }

function backfillStore(): { merged: string[]; mergeRetiredWorktreeNames: () => boolean } {
  const merged: string[] = []
  return {
    merged,
    mergeRetiredWorktreeNames: (...args: unknown[]) => {
      merged.push(...(args[1] as Iterable<string>))
      return true
    }
  } as never
}

describe('retirement backfill against a stalled listing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    readdirMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up rather than hanging generated create on a listing that never returns', async () => {
    readdirMock.mockImplementation(() => new Promise(() => {}))
    const store = backfillStore()

    const backfill = ensureRetiredWorktreeNamesBackfilled(store, repo, settings)
    const settled = expect(backfill).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)

    await settled
  })
})
