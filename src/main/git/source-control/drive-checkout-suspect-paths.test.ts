import { describe, expect, it } from 'vitest'
import { DriveCheckoutSuspectPaths, repoRelativeWatcherPath } from './drive-checkout-suspect-paths'

const REPO = String.raw`C:\Users\dev\My Repo`

describe('repoRelativeWatcherPath', () => {
  it('matches the root case- and Unicode-insensitively but keeps the tail spelling', () => {
    const decomposed = 'Cafe\u0301'
    const repo = String.raw`C:\Work\Café`
    expect(repoRelativeWatcherPath(repo, `c:\\WORK\\${decomposed}\\Src\\Ünï.TS`)).toBe('Src/Ünï.TS')
  })

  it('rejects the root itself, siblings, prefixes, and .git internals', () => {
    expect(repoRelativeWatcherPath(REPO, REPO)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`C:\Users\dev\My Repo2\a.ts`)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`D:\Users\dev\My Repo\a.ts`)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`C:\Users\dev\My Repo\.git\index`)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`C:\Users\dev\My Repo\sub\.GIT\HEAD`)).toBeNull()
  })
})

describe('DriveCheckoutSuspectPaths', () => {
  const root = { rootPath: REPO }
  const event = (relativePath: string, type = 'update'): { type: string; path: string } => ({
    type,
    path: `${REPO}\\${relativePath.replace(/\//g, '\\')}`
  })

  it('treats a reinstalled watcher as a restart but keeps its own events', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO)
    tracker.recordEvents(root, [event('old.ts')])
    expect(tracker.beginPoll(root)?.size).toBe(1)
    const reinstalled = { rootPath: REPO }
    tracker.recordEvents(reinstalled, [event('new.ts')])
    expect([...(tracker.beginPoll(reinstalled)?.keys() ?? [])]).toEqual(['new.ts'])
    expect(tracker.lastDegradeReason).toBe('watcher-restart')
  })

  it('keeps rechecked-dirty paths through overflow, interruption, restart, and a lost watcher', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO, 3)
    tracker.recordEvents(root, [event('hidden.ts')])
    tracker.confirmDirty('hidden.ts', tracker.beginPoll(root)?.get('hidden.ts') ?? 0)
    tracker.recordEvents(root, [event('a'), event('b'), event('c')])
    expect(tracker.lastDegradeReason).toBe('over-limit')
    tracker.recordInterruption(root)
    const reinstalled = { rootPath: REPO }
    expect([...(tracker.beginPoll(reinstalled)?.keys() ?? [])]).toEqual(['hidden.ts'])
    expect([...(tracker.beginPoll(null)?.keys() ?? [])]).toEqual(['hidden.ts'])
  })

  it('stays bounded when rechecked-dirty paths alone fill the limit', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO, 2)
    tracker.recordEvents(root, [event('a'), event('b')])
    const snapshot = tracker.beginPoll(root)
    tracker.confirmDirty('a', snapshot?.get('a') ?? 0)
    tracker.confirmDirty('b', snapshot?.get('b') ?? 0)
    tracker.recordEvents(root, [event('c')])
    expect([...(tracker.beginPoll(root)?.keys() ?? [])]).toEqual(['a', 'b'])
    expect(tracker.lastDegradeReason).toBe('over-limit')
  })

  it('keeps a dirty proof when the watcher was interrupted during the recheck', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO)
    tracker.recordEvents(root, [event('a.ts')])
    const snapshot = tracker.beginPoll(root)
    tracker.recordInterruption(root)
    tracker.confirmDirty('a.ts', snapshot?.get('a.ts') ?? 0)
    expect([...(tracker.beginPoll(root)?.keys() ?? [])]).toEqual(['a.ts'])
  })

  it('drops only when no newer event re-armed the path', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO)
    tracker.recordEvents(root, [event('a.ts'), event('b.ts')])
    const snapshot = tracker.beginPoll(root)!
    tracker.recordEvents(root, [event('b.ts')])
    tracker.drop('a.ts', snapshot.get('a.ts')!)
    tracker.drop('b.ts', snapshot.get('b.ts')!)
    expect([...(tracker.beginPoll(root)?.keys() ?? [])]).toEqual(['b.ts'])
  })
})
