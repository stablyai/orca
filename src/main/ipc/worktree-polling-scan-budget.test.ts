import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import { startWorktreeBaseDirectoryPoller } from './worktree-base-directory-poller'
import {
  WorktreePollingScanBudget,
  type WorktreePollingCapacityError
} from './worktree-polling-scan-budget'

describe('worktree polling scan budget', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-worktree-poll-bounds-'))
    cleanupPaths.push(root)
    return root
  }

  function makeTarget(kind: 'base' | 'git-common', path: string): WorktreeBaseWatchTarget {
    return {
      key: `${kind}:local:${path}`,
      kind,
      path,
      repos: new Map([
        [
          'repo-1',
          {
            repoId: 'repo-1',
            repoName: 'project',
            nestWorkspaces: false
          }
        ]
      ])
    }
  }

  it('accepts exact entry, path-count, and path-byte limits', () => {
    const budget = new WorktreePollingScanBudget({
      maxScannedEntries: 2,
      maxRetainedPaths: 2,
      maxRetainedPathBytes: 6
    })

    budget.claimEntry()
    budget.claimEntry()
    budget.claimRetainedPath('one')
    expect(() => budget.claimRetainedPath('two')).not.toThrow()
  })

  it('rejects the first scanned entry over the limit', () => {
    const budget = new WorktreePollingScanBudget({ maxScannedEntries: 1 })
    budget.claimEntry()

    expect(() => budget.claimEntry()).toThrow(
      expect.objectContaining<Partial<WorktreePollingCapacityError>>({
        resource: 'scanned entries',
        observed: 2,
        limit: 1
      })
    )
  })

  it('rejects the first retained path byte over the limit', () => {
    const budget = new WorktreePollingScanBudget({
      maxRetainedPaths: 2,
      maxRetainedPathBytes: 5
    })
    budget.claimRetainedPath('one')

    expect(() => budget.claimRetainedPath('two')).toThrow(
      expect.objectContaining<Partial<WorktreePollingCapacityError>>({
        resource: 'retained path bytes',
        observed: 6,
        limit: 5
      })
    )
  })

  it('accepts the exact retained repo budget and rejects one byte less', () => {
    const exact = new WorktreePollingScanBudget({
      maxRepoConfigs: 1,
      maxRetainedRepoBytes: 130
    })
    expect(() => exact.claimRepoConfig('a', 'b')).not.toThrow()

    const overflow = new WorktreePollingScanBudget({
      maxRepoConfigs: 1,
      maxRetainedRepoBytes: 129
    })
    expect(() => overflow.claimRepoConfig('a', 'b')).toThrow(
      expect.objectContaining<Partial<WorktreePollingCapacityError>>({
        resource: 'retained repo bytes',
        observed: 130,
        limit: 129
      })
    )
  })

  it('rejects the first repo config over the count limit', () => {
    const budget = new WorktreePollingScanBudget({ maxRepoConfigs: 1 })
    budget.claimRepoConfig('repo-1', 'one')

    expect(() => budget.claimRepoConfig('repo-2', 'two')).toThrow(
      expect.objectContaining<Partial<WorktreePollingCapacityError>>({
        resource: 'repo configs',
        observed: 2,
        limit: 1
      })
    )
  })

  it('starts a base poller at the exact directory-entry limit', async () => {
    const root = await createRoot()
    await Promise.all([mkdir(join(root, 'one')), mkdir(join(root, 'two'))])
    const target = makeTarget('base', root)

    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      () => {},
      {
        scanLimits: {
          maxScannedEntries: 2,
          maxRetainedPaths: 3
        }
      }
    )

    await poller.unsubscribe()
  })

  it('rejects a base snapshot on the first directory entry over the limit', async () => {
    const root = await createRoot()
    await Promise.all([
      mkdir(join(root, 'one')),
      mkdir(join(root, 'two')),
      mkdir(join(root, 'three'))
    ])
    const target = makeTarget('base', root)

    await expect(
      startWorktreeBaseDirectoryPoller(
        target,
        () => target.repos,
        () => {},
        {
          scanLimits: { maxScannedEntries: 2 }
        }
      )
    ).rejects.toMatchObject({ resource: 'scanned entries', observed: 3, limit: 2 })
  })

  it('keeps the last complete snapshot while over capacity and resumes afterward', async () => {
    const root = await createRoot()
    const knownWorktree = join(root, 'known')
    await mkdir(knownWorktree)
    await writeFile(join(knownWorktree, '.git'), 'gitdir: elsewhere')
    const target = makeTarget('base', root)
    const events: { type: string; path: string }[] = []
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (nextEvents) => events.push(...nextEvents),
      {
        pollIntervalMs: 100,
        scanLimits: { maxScannedEntries: 2 }
      }
    )

    try {
      await Promise.all([
        mkdir(join(root, 'overflow-a')),
        mkdir(join(root, 'overflow-b')),
        mkdir(join(root, 'overflow-c'))
      ])
      await rm(knownWorktree, { recursive: true })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(events).toEqual([])

      await Promise.all([
        rm(join(root, 'overflow-b'), { recursive: true }),
        rm(join(root, 'overflow-c'), { recursive: true })
      ])
      await vi.waitFor(
        () => {
          expect(events).toContainEqual({ type: 'delete', path: knownWorktree })
        },
        { timeout: 2_000 }
      )
    } finally {
      await poller.unsubscribe()
    }
  })

  it('pauses snapshots for excess repo configs and resumes when they are removed', async () => {
    const root = await createRoot()
    const knownWorktree = join(root, 'known')
    await mkdir(knownWorktree)
    await writeFile(join(knownWorktree, '.git'), 'gitdir: elsewhere')
    const target = makeTarget('base', root)
    const events: { type: string; path: string }[] = []
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (nextEvents) => events.push(...nextEvents),
      {
        pollIntervalMs: 100,
        scanLimits: { maxRepoConfigs: 1 }
      }
    )

    try {
      target.repos.set('repo-2', {
        repoId: 'repo-2',
        repoName: 'second',
        nestWorkspaces: false
      })
      await rm(knownWorktree, { recursive: true })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(events).toEqual([])

      target.repos.delete('repo-2')
      await vi.waitFor(
        () => {
          expect(events).toContainEqual({ type: 'delete', path: knownWorktree })
        },
        { timeout: 2_000 }
      )
    } finally {
      await poller.unsubscribe()
    }
  })

  it('starts git-common polling at the exact linked-worktree limit', async () => {
    const root = await createRoot()
    await Promise.all([
      mkdir(join(root, 'worktrees', 'one'), { recursive: true }),
      mkdir(join(root, 'worktrees', 'two'), { recursive: true })
    ])
    const target = makeTarget('git-common', root)

    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      () => {},
      {
        platform: 'linux',
        scanLimits: {
          maxScannedEntries: 2,
          maxRetainedPaths: 2
        }
      }
    )

    await poller.unsubscribe()
  })

  it('rejects git-common polling on the first linked worktree over the limit', async () => {
    const root = await createRoot()
    await Promise.all([
      mkdir(join(root, 'worktrees', 'one'), { recursive: true }),
      mkdir(join(root, 'worktrees', 'two'), { recursive: true }),
      mkdir(join(root, 'worktrees', 'three'), { recursive: true })
    ])
    const target = makeTarget('git-common', root)

    await expect(
      startWorktreeBaseDirectoryPoller(
        target,
        () => target.repos,
        () => {},
        {
          platform: 'linux',
          scanLimits: { maxScannedEntries: 2 }
        }
      )
    ).rejects.toMatchObject({ resource: 'scanned entries', observed: 3, limit: 2 })
  })
})
