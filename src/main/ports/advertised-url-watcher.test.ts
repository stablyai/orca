import { describe, expect, it } from 'vitest'
import { AdvertisedUrlWatcher } from './advertised-url-watcher'

const WORKTREE = 'repo::/repo'
const PTY = 'pty-1'

function bindFresh(now = 1_000): AdvertisedUrlWatcher {
  const watcher = new AdvertisedUrlWatcher({ now: () => now })
  watcher.bindPty(PTY, WORKTREE)
  return watcher
}

describe('extractUrlCandidates', () => {
  it('does not cache a partial default-port URL from a cursor-skip redraw', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'Local: http://localh\x1b[1Cst/\n')
    expect(watcher.lookup(WORKTREE, 80)).toBeUndefined()
  })
})

describe('AdvertisedUrlWatcher.ingest', () => {
  it('reassembles a URL split across two chunks', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, '  Network: https://local.getmontecarlo')
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    watcher.ingest(PTY, '.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.origin).toBe('https://local.getmontecarlo.com:3001')
  })

  it('sanitizes to origin (drops path, query, fragment, userinfo)', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'go to https://user:pass@example.com:3001/callback?token=secret#x\n')
    expect(watcher.lookup(WORKTREE, 3001)?.origin).toBe('https://example.com:3001')
  })

  it('unbindPty drops buffered state for the PTY', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'cached https://cached.example.com:3002/\n')
    watcher.ingest(PTY, 'partial https://example.com:3001')
    const events: { worktreeId: string; port: number }[] = []
    watcher.onDidChange((event) => events.push(event))
    watcher.unbindPty(PTY)
    watcher.bindPty(PTY, WORKTREE)
    watcher.ingest(PTY, '/now\n')
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    expect(watcher.lookupBest([WORKTREE], 3002)).toBeUndefined()
    expect(events).toContainEqual({ worktreeId: WORKTREE, port: 3002 })
  })

  it('different worktrees on the same port are tracked independently', () => {
    const watcher = bindFresh()
    watcher.bindPty('pty-2', 'repo::/other')
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.ingest('pty-2', 'B: https://b.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.host).toBe('a.example.com')
    expect(watcher.lookup('repo::/other', 3001)?.host).toBe('b.example.com')
  })
})
