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
const { RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS, RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS } =
  await import('./worktree-retirement-backfill-scan')

/** A `readdir` the test releases by hand, standing in for a wedged NFS/SMB/WSL mount. */
function stalledReaddir(): { install: () => void; release: () => void } {
  let release: () => void = () => {}
  return {
    install: () =>
      readdirMock.mockImplementation(
        () => new Promise((_resolve, reject) => (release = () => reject(new Error('EIO'))))
      ),
    release: () => release()
  }
}

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

  it('recovers the namespace once the mount comes back, instead of staying wedged until restart', async () => {
    const stall = stalledReaddir()
    stall.install()
    const store = backfillStore()

    const stalled = ensureRetiredWorktreeNamesBackfilled(store, repo, settings)
    const settled = expect(stalled).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    await settled

    // The mount comes back: the kernel releases the abandoned call, which is what frees the
    // namespace to be listed again. Retrying while it is still stuck would only stack a second one.
    stall.release()
    readdirMock.mockResolvedValue([{ name: 'nautilus', isDirectory: () => true }])
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS)

    await ensureRetiredWorktreeNamesBackfilled(store, repo, settings)
    expect(store.merged).toContain('nautilus')
  })

  it('does not re-probe a mount whose previous listing is still stuck', async () => {
    stalledReaddir().install()
    const store = backfillStore()

    const stalled = ensureRetiredWorktreeNamesBackfilled(store, repo, settings)
    const settled = expect(stalled).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    await settled

    const callsWhileStuck = readdirMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS * 5)
    await expect(ensureRetiredWorktreeNamesBackfilled(store, repo, settings)).rejects.toThrow(
      /exceeded/
    )

    expect(readdirMock.mock.calls.length).toBe(callsWhileStuck)
  })
})
