import { describe, expect, it } from 'vitest'
import {
  AdvertisedUrlWatcher,
  classifyHost,
  extractUrlCandidates,
  stripTerminalControls
} from './advertised-url-watcher'

const WORKTREE = 'repo::/repo'
const PTY = 'pty-1'

function bindFresh(now = 1_000): AdvertisedUrlWatcher {
  const watcher = new AdvertisedUrlWatcher({ now: () => now })
  watcher.bindPty(PTY, WORKTREE)
  return watcher
}

describe('stripTerminalControls', () => {
  it('strips CSI color codes and CRLF', () => {
    expect(stripTerminalControls('\x1b[32mhello\x1b[0m\r\n')).toBe('hello\n')
  })

  it('strips OSC sequences terminated by BEL or ST', () => {
    expect(stripTerminalControls('\x1b]0;title\x07rest')).toBe('rest')
    expect(stripTerminalControls('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')).toBe(
      'link'
    )
  })

  it('drops non-printable bytes but keeps whitespace and printable ASCII', () => {
    expect(stripTerminalControls('a\x00b\x08c\td')).toBe('abc\td')
  })
})

describe('extractUrlCandidates', () => {
  it('finds plain URLs', () => {
    const urls = extractUrlCandidates('Server: https://example.com:3001/ ready')
    expect(urls.map((u) => u.href)).toEqual(['https://example.com:3001/'])
  })

  it('trims trailing punctuation', () => {
    const urls = extractUrlCandidates('open https://example.com:3001/. now.')
    expect(urls).toHaveLength(1)
    expect(urls[0].port).toBe('3001')
  })

  it('parses IPv6 with brackets', () => {
    const urls = extractUrlCandidates('Local: http://[::1]:5173/')
    expect(urls).toHaveLength(1)
    // Node returns IPv6 hostnames with brackets retained.
    expect(urls[0].hostname.replace(/^\[|\]$/g, '')).toBe('::1')
    expect(urls[0].port).toBe('5173')
  })

  it('ignores non-http(s) schemes and bare hostnames', () => {
    expect(extractUrlCandidates('ftp://example.com')).toHaveLength(0)
    expect(extractUrlCandidates('example.com:3001')).toHaveLength(0)
  })

  it('handles multiple URLs in one line', () => {
    const urls = extractUrlCandidates(
      'Local: http://localhost:3001/  Network: https://custom:3001/'
    )
    expect(urls.map((u) => u.hostname).sort()).toEqual(['custom', 'localhost'])
  })
})

describe('classifyHost', () => {
  it('classifies loopback hosts', () => {
    expect(classifyHost('localhost')).toBe('loopback')
    expect(classifyHost('127.0.0.1')).toBe('loopback')
    expect(classifyHost('::1')).toBe('loopback')
  })

  it('classifies private IPv4 ranges', () => {
    expect(classifyHost('10.0.0.1')).toBe('private-ip')
    expect(classifyHost('172.16.5.5')).toBe('private-ip')
    expect(classifyHost('192.168.1.50')).toBe('private-ip')
    expect(classifyHost('169.254.1.1')).toBe('private-ip')
  })

  it('classifies public IPv4', () => {
    expect(classifyHost('8.8.8.8')).toBe('public-ip')
    expect(classifyHost('172.15.0.1')).toBe('public-ip') // just outside private range
  })

  it('classifies DNS hostnames as custom', () => {
    expect(classifyHost('local.getmontecarlo.com')).toBe('custom')
    expect(classifyHost('app.example.dev')).toBe('custom')
  })
})

describe('AdvertisedUrlWatcher.ingest', () => {
  it('captures a complete URL printed in one chunk', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, '  Network: https://local.getmontecarlo.com:3001/\n')
    const found = watcher.lookup(WORKTREE, 3001)
    expect(found?.origin).toBe('https://local.getmontecarlo.com:3001')
    expect(found?.hostKind).toBe('custom')
    expect(found?.protocol).toBe('https')
  })

  it('reassembles a URL split across two chunks', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, '  Network: https://local.getmontecarlo')
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    watcher.ingest(PTY, '.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.origin).toBe('https://local.getmontecarlo.com:3001')
  })

  it('reassembles an ANSI escape split across two chunks', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, '\x1b[32mhttps://example.com:3001/\x1b')
    // Partial ESC at end keeps everything buffered; nothing emitted yet.
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    watcher.ingest(PTY, '[0m\n')
    expect(watcher.lookup(WORKTREE, 3001)?.origin).toBe('https://example.com:3001')
  })

  it('sanitizes to origin (drops path, query, fragment, userinfo)', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'go to https://user:pass@example.com:3001/callback?token=secret#x\n')
    expect(watcher.lookup(WORKTREE, 3001)?.origin).toBe('https://example.com:3001')
  })

  it('omits default port from origin', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'Listening on https://example.com/ now\n')
    expect(watcher.lookup(WORKTREE, 443)?.origin).toBe('https://example.com')
  })

  it('re-brackets IPv6 hosts in the origin', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'Local: http://[::1]:5173/\n')
    expect(watcher.lookup(WORKTREE, 5173)?.origin).toBe('http://[::1]:5173')
  })

  it('prefers a custom DNS host over loopback for the same port', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, '  Local:   http://localhost:3001/\n')
    watcher.ingest(PTY, '  Network: https://custom.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.host).toBe('custom.example.com')
  })

  it('does not let a later loopback URL overwrite a custom DNS host', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'Network: https://custom.example.com:3001/\n')
    watcher.ingest(PTY, 'Local: http://localhost:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.host).toBe('custom.example.com')
  })

  it('prefers https over http when scores match and a newer https is seen', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: http://app.example.com:3001/\n')
    watcher.ingest(PTY, 'B: https://app.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.protocol).toBe('https')
  })

  it('prefers loopback over a private LAN IP', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'Network: http://192.168.1.50:3001/\n')
    watcher.ingest(PTY, 'Local: http://localhost:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.hostKind).toBe('loopback')
  })

  it('buffers data that arrives before bindPty and replays on bind', () => {
    const watcher = new AdvertisedUrlWatcher({ now: () => 1_000 })
    watcher.ingest('pty-X', 'early https://app.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    watcher.bindPty('pty-X', WORKTREE)
    expect(watcher.lookup(WORKTREE, 3001)?.host).toBe('app.example.com')
  })

  it('unbindPty drops buffered state for the PTY', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'partial https://example.com:3001') // no newline → buffered
    watcher.unbindPty(PTY)
    // After unbind, the buffer is gone, so a completing chunk on a fresh
    // binding would have to repeat the URL.
    watcher.bindPty(PTY, WORKTREE)
    watcher.ingest(PTY, '/now\n')
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
  })

  it('different worktrees on the same port are tracked independently', () => {
    const watcher = bindFresh()
    watcher.bindPty('pty-2', 'repo::/other')
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.ingest('pty-2', 'B: https://b.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001)?.host).toBe('a.example.com')
    expect(watcher.lookup('repo::/other', 3001)?.host).toBe('b.example.com')
  })

  it('LRU-evicts the oldest entry when the cache cap is exceeded', () => {
    const watcher = new AdvertisedUrlWatcher({ now: () => 1_000, maxCacheEntries: 2 })
    watcher.bindPty(PTY, WORKTREE)
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n', 100)
    watcher.ingest(PTY, 'B: https://b.example.com:3002/\n', 200)
    watcher.ingest(PTY, 'C: https://c.example.com:3003/\n', 300)
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    expect(watcher.lookup(WORKTREE, 3002)?.host).toBe('b.example.com')
    expect(watcher.lookup(WORKTREE, 3003)?.host).toBe('c.example.com')
  })

  it('invalidate drops one cache entry', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.invalidate(WORKTREE, 3001)
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
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
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    expect(watcher.lookup(WORKTREE, 3001, 4242)?.validatedListenerPid).toBe(4242)
    // Different PID → port was reused by another process.
    expect(watcher.lookup(WORKTREE, 3001, 9999)).toBeUndefined()
    // Entry is gone.
    expect(watcher.lookup(WORKTREE, 3001, 4242)).toBeUndefined()
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
})
