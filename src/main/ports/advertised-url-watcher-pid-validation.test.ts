import { describe, expect, it } from 'vitest'
import { AdvertisedUrlWatcher } from './advertised-url-watcher'

const WORKTREE = 'repo::/repo'
const PTY = 'pty-1'

function bindFresh(now = 1_000): AdvertisedUrlWatcher {
  const watcher = new AdvertisedUrlWatcher({ now: () => now })
  watcher.bindPty(PTY, WORKTREE)
  return watcher
}

describe('AdvertisedUrlWatcher.lookupBest PID validation', () => {
  it('pins the listener PID on first lookupBest match', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    const first = watcher.lookupBest([WORKTREE], 3001, 4242)
    expect(first?.validatedListenerPid).toBe(4242)
    const second = watcher.lookupBest([WORKTREE], 3001, 4242)
    expect(second?.host).toBe('a.example.com')
  })

  it('evicts stale candidates after scanner-observed listener PID changes', () => {
    const watcher = bindFresh()
    watcher.bindPty('pty-2', 'repo::/wt2')
    const events: { worktreeId: string; port: number }[] = []
    watcher.onDidChange((event) => events.push(event))
    watcher.ingest(PTY, 'A: http://localhost:3001/\n')
    watcher.ingest('pty-2', 'B: https://custom.example.com:3001/\n')
    watcher.reconcileScan([WORKTREE, 'repo::/wt2'], [{ port: 3001, pid: 4242 }])
    expect(watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001, 4242)?.host).toBe(
      'custom.example.com'
    )
    expect(watcher.lookup(WORKTREE, 3001)?.validatedListenerPid).toBeUndefined()
    // Remote port reused by a different process: the pinned winner and the
    // unvalidated non-winner both get evicted by scanner reconciliation.
    watcher.reconcileScan([WORKTREE, 'repo::/wt2'], [{ port: 3001, pid: 9999 }])
    expect(watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001, 9999)).toBeUndefined()
    expect(watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001)).toBeUndefined()
    expect(events).toContainEqual({ worktreeId: WORKTREE, port: 3001 })
    expect(events).toContainEqual({ worktreeId: 'repo::/wt2', port: 3001 })
  })

  it('pins only the selected lookupBest winner when candidates share a port', () => {
    const watcher = bindFresh()
    watcher.bindPty('pty-2', 'repo::/wt2')
    watcher.ingest(PTY, 'A: http://localhost:3001/\n')
    watcher.ingest('pty-2', 'B: https://custom.example.com:3001/\n')

    const best = watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001, 4242)

    expect(best?.host).toBe('custom.example.com')
    expect(watcher.lookup('repo::/wt2', 3001)?.validatedListenerPid).toBe(4242)
    expect(watcher.lookup(WORKTREE, 3001)?.validatedListenerPid).toBeUndefined()
  })

  it('falls through to a still-valid candidate when one entry was reassigned', () => {
    const watcher = bindFresh()
    watcher.bindPty('pty-2', 'repo::/wt2')
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.ingest('pty-2', 'B: https://b.example.com:3001/\n')
    // Pin only the WORKTREE entry to PID 100.
    expect(watcher.lookup(WORKTREE, 3001, 100)?.host).toBe('a.example.com')
    // Now query with PID 200 across both worktrees: the WORKTREE entry
    // gets evicted (mismatch), and the repo::/wt2 entry - which had no
    // pinned PID yet - gets pinned to 200 and wins.
    expect(watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001, 200)?.host).toBe('b.example.com')
  })
})

describe('AdvertisedUrlWatcher.lookup PID validation', () => {
  it('records the listener PID on first lookup that supplies one', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    const first = watcher.lookup(WORKTREE, 3001, 4242)
    expect(first?.validatedListenerPid).toBe(4242)
    // Same PID on a later lookup keeps the entry.
    const second = watcher.lookup(WORKTREE, 3001, 4242)
    expect(second?.host).toBe('a.example.com')
  })

  it('evicts the entry when the listener PID changes', () => {
    const watcher = bindFresh()
    const events: { worktreeId: string; port: number }[] = []
    watcher.onDidChange((event) => events.push(event))
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001, 4242)?.validatedListenerPid).toBe(4242)
    // Different PID means the port was reused by another process.
    expect(watcher.lookup(WORKTREE, 3001, 9999)).toBeUndefined()
    // Entry is gone.
    expect(watcher.lookup(WORKTREE, 3001, 4242)).toBeUndefined()
    expect(events).toContainEqual({ worktreeId: WORKTREE, port: 3001 })
  })

  it('skips validation when no PID is provided', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.lookup(WORKTREE, 3001, 4242) // pins PID
    // Looking up without a PID does not evict.
    expect(watcher.lookup(WORKTREE, 3001)?.host).toBe('a.example.com')
  })

  it('replacing a cached URL resets validatedListenerPid', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: http://localhost:3001/\n')
    watcher.lookup(WORKTREE, 3001, 100) // pins PID to old listener
    // A higher-score URL replaces; the new entry starts unvalidated.
    watcher.ingest(PTY, 'B: https://custom.example.com:3001/\n')
    const refreshed = watcher.lookup(WORKTREE, 3001)
    expect(refreshed?.host).toBe('custom.example.com')
    expect(refreshed?.validatedListenerPid).toBeUndefined()
  })

  it('evicts an unvalidated URL when scanner sees its port absent before reuse', () => {
    const watcher = bindFresh()
    const events: { worktreeId: string; port: number }[] = []
    watcher.onDidChange((event) => events.push(event))

    watcher.reconcileScan([WORKTREE], [{ port: 3001, pid: 100 }])
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.reconcileScan([WORKTREE], [])
    watcher.reconcileScan([WORKTREE], [{ port: 3001, pid: 200 }])

    expect(watcher.lookup(WORKTREE, 3001, 200)).toBeUndefined()
    expect(events).toContainEqual({ worktreeId: WORKTREE, port: 3001 })
  })

  it('keeps a startup URL through one absent settling scan before the listener appears', () => {
    const watcher = bindFresh()

    watcher.reconcileScan([WORKTREE], [])
    watcher.ingest(PTY, 'Nautilus: http://localhost:3002/\n')
    watcher.reconcileScan([WORKTREE], [])
    watcher.reconcileScan([WORKTREE], [{ port: 3002, pid: 4242 }])

    const advertised = watcher.lookup(WORKTREE, 3002, 4242)
    expect(advertised?.origin).toBe('http://localhost:3002')
    expect(advertised?.validatedListenerPid).toBe(4242)
  })

  it('keeps a startup URL with unknown baseline through one absent settling scan', () => {
    const watcher = bindFresh()

    watcher.ingest(PTY, 'Nautilus: http://localhost:3002/\n')
    watcher.reconcileScan([WORKTREE], [])
    watcher.reconcileScan([WORKTREE], [{ port: 3002, pid: 4242 }])

    const advertised = watcher.lookup(WORKTREE, 3002, 4242)
    expect(advertised?.origin).toBe('http://localhost:3002')
    expect(advertised?.validatedListenerPid).toBe(4242)
  })

  it('evicts a startup URL after the listener remains absent past the settling scan', () => {
    const watcher = bindFresh()

    watcher.reconcileScan([WORKTREE], [])
    watcher.ingest(PTY, 'Nautilus: http://localhost:3002/\n')
    watcher.reconcileScan([WORKTREE], [])
    watcher.reconcileScan([WORKTREE], [])

    expect(watcher.lookup(WORKTREE, 3002)).toBeUndefined()
  })

  it('evicts a startup URL with unknown baseline after a second absent scan', () => {
    const watcher = bindFresh()

    watcher.ingest(PTY, 'Nautilus: http://localhost:3002/\n')
    watcher.reconcileScan([WORKTREE], [])
    watcher.reconcileScan([WORKTREE], [])

    expect(watcher.lookup(WORKTREE, 3002)).toBeUndefined()
  })

  it('evicts an unvalidated URL when scanner observes a different PID first', () => {
    const watcher = bindFresh()

    watcher.reconcileScan([WORKTREE], [{ port: 3001, pid: 100 }])
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.reconcileScan([WORKTREE], [{ port: 3001, pid: 200 }])

    expect(watcher.lookup(WORKTREE, 3001, 200)).toBeUndefined()
  })
})
