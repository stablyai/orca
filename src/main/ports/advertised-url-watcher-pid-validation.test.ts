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
    watcher.reconcileScan([WORKTREE, 'repo::/wt2'], [{ port: 3001, pid: 9999 }])
    expect(watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001, 9999)).toBeUndefined()
    expect(watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001)).toBeUndefined()
    expect(events).toContainEqual({ worktreeId: WORKTREE, port: 3001 })
    expect(events).toContainEqual({ worktreeId: 'repo::/wt2', port: 3001 })
  })

  it('falls through to a still-valid candidate when one entry was reassigned', () => {
    const watcher = bindFresh()
    watcher.bindPty('pty-2', 'repo::/wt2')
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.ingest('pty-2', 'B: https://b.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001, 100)?.host).toBe('a.example.com')
    // Evict the mismatched pinned entry; only the previously unpinned candidate can win.
    expect(watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001, 200)?.host).toBe('b.example.com')
  })
})

describe('AdvertisedUrlWatcher.lookup PID validation', () => {
  it('replacing a cached URL resets validatedListenerPid', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: http://localhost:3001/\n')
    watcher.lookup(WORKTREE, 3001, 100)
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

describe('workspace-grouped listener reconciliation', () => {
  it('keeps snapshots isolated and expires changed or absent listeners', () => {
    const watcher = new AdvertisedUrlWatcher()
    const initial = new Map([
      ['a', [{ port: 3001, pid: 100 }]],
      ['b', [{ port: 3001, pid: 200 }]],
      ['c', [{ port: 3002, pid: 300 }]]
    ])
    watcher.reconcileWorkspaces(initial)
    watcher.bindPty('a-pty', 'a')
    watcher.bindPty('b-pty', 'b')
    watcher.bindPty('c-pty', 'c')
    watcher.ingest('a-pty', 'http://a.local:3001/\n')
    watcher.ingest('b-pty', 'http://b.local:3001/\n')
    watcher.ingest('c-pty', 'http://c.local:3002/\n')

    watcher.reconcileWorkspaces(
      new Map([
        ['a', [{ port: 3001, pid: 100 }]],
        ['b', [{ port: 3001, pid: 201 }]],
        ['c', []]
      ])
    )

    expect(watcher.lookup('a', 3001, 100)?.origin).toBe('http://a.local:3001')
    expect(watcher.lookup('b', 3001, 201)).toBeUndefined()
    expect(watcher.lookup('c', 3002)).toBeUndefined()
  })
})
