import { describe, expect, it } from 'vitest'
import { DriveCheckoutSuspectPaths, repoRelativeWatcherPath } from './drive-checkout-suspect-paths'

const REPO = String.raw`C:\Users\dev\My Repo`

describe('repoRelativeWatcherPath', () => {
  it('maps a Windows event path to a repo-relative POSIX path', () => {
    expect(repoRelativeWatcherPath(REPO, String.raw`C:\Users\dev\My Repo\src\a b.ts`)).toBe(
      'src/a b.ts'
    )
  })

  it('matches the root case- and Unicode-insensitively but keeps the tail spelling', () => {
    const decomposed = 'Cafe\u0301'
    const repo = String.raw`C:\Work\Café`
    expect(repoRelativeWatcherPath(repo, `c:\\WORK\\${decomposed}\\Src\\Ünï.TS`)).toBe('Src/Ünï.TS')
  })

  it('accepts mixed separators', () => {
    expect(repoRelativeWatcherPath(REPO, 'C:/Users/dev/My Repo/docs/x.md')).toBe('docs/x.md')
  })

  it('rejects the root itself, siblings, prefixes, and .git internals', () => {
    expect(repoRelativeWatcherPath(REPO, REPO)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`C:\Users\dev\My Repo2\a.ts`)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`D:\Users\dev\My Repo\a.ts`)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`C:\Users\dev\My Repo\.git\index`)).toBeNull()
    expect(repoRelativeWatcherPath(REPO, String.raw`C:\Users\dev\My Repo\sub\.GIT\HEAD`)).toBeNull()
  })

  it('keeps POSIX roots case-sensitive', () => {
    expect(repoRelativeWatcherPath('/repo', '/repo/A.ts')).toBe('A.ts')
    expect(repoRelativeWatcherPath('/repo', '/Repo/A.ts')).toBeNull()
    expect(repoRelativeWatcherPath('/repo', String.raw`C:\repo\A.ts`)).toBeNull()
  })
})

describe('DriveCheckoutSuspectPaths', () => {
  const root = { rootPath: REPO }
  const event = (relativePath: string, type = 'update'): { type: string; path: string } => ({
    type,
    path: `${REPO}\\${relativePath.replace(/\//g, '\\')}`
  })

  it('collects non-delete events from a covering root', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO)
    tracker.recordEvents(root, [
      event('a.ts'),
      event('b.ts', 'delete'),
      event('src/c.ts', 'create')
    ])
    expect([...(tracker.beginPoll(root)?.keys() ?? [])]).toEqual(['a.ts', 'src/c.ts'])
  })

  it('accepts an ancestor watch root and ignores unrelated roots', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO)
    const parent = { rootPath: String.raw`C:\Users\dev` }
    tracker.recordEvents({ rootPath: String.raw`C:\Other` }, [event('a.ts')])
    tracker.recordEvents(parent, [event('b.ts')])
    expect([...(tracker.beginPoll(parent)?.keys() ?? [])]).toEqual(['b.ts'])
  })

  it('stays minimal-only and records degraded when no watcher covers the repo', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO)
    tracker.recordEvents(root, [event('a.ts')])
    expect(tracker.beginPoll(null)).toBeNull()
    expect(tracker.lastDegradeReason).toBe('no-watcher')
    expect(tracker.size).toBe(0)
    expect(tracker.beginPoll(null)).toBeNull()
    expect(tracker.degradeCount).toBe(1)
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

  it('clears on interruption and resumes collecting', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO)
    tracker.recordEvents(root, [event('a.ts')])
    tracker.recordInterruption(root)
    expect(tracker.lastDegradeReason).toBe('watcher-interrupted')
    expect(tracker.beginPoll(root)).toBeNull()
    tracker.recordEvents(root, [event('b.ts')])
    expect([...(tracker.beginPoll(root)?.keys() ?? [])]).toEqual(['b.ts'])
  })

  it('clears past the limit, then resumes from the next path', () => {
    const tracker = new DriveCheckoutSuspectPaths(REPO, 3)
    tracker.recordEvents(root, [event('a'), event('b'), event('c'), event('a')])
    expect(tracker.size).toBe(3)
    tracker.recordEvents(root, [event('d'), event('e')])
    expect(tracker.lastDegradeReason).toBe('over-limit')
    expect([...(tracker.beginPoll(root)?.keys() ?? [])]).toEqual(['d', 'e'])
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
