import { describe, expect, it, vi } from 'vitest'
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

  it('classifies private IPv6 ranges', () => {
    expect(classifyHost('fc00::1')).toBe('private-ip')
    expect(classifyHost('fd12::1')).toBe('private-ip')
    expect(classifyHost('fe80::1')).toBe('private-ip')
    expect(classifyHost('fe90::1')).toBe('private-ip')
    expect(classifyHost('fea0::1')).toBe('private-ip')
    expect(classifyHost('[febf::1]')).toBe('private-ip')
  })

  it('classifies IPv6 addresses outside private ranges as public', () => {
    expect(classifyHost('2001:db8::1')).toBe('public-ip')
    expect(classifyHost('fe7f::1')).toBe('public-ip')
    expect(classifyHost('fec0::1')).toBe('public-ip')
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

  it('does not scan buffered PTY text until a line break arrives', () => {
    const watcher = bindFresh()
    const charCodeAtSpy = vi.spyOn(String.prototype, 'charCodeAt')
    watcher.ingest(PTY, '  Network: https://local.getmontecarlo')
    const charCodeAtCalls = charCodeAtSpy.mock.calls.length
    charCodeAtSpy.mockRestore()

    expect(charCodeAtCalls).toBe(0)
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

  it('keeps repeated PTY binds as no-ops once pending data is drained', () => {
    const watcher = new AdvertisedUrlWatcher({ now: () => 1_000 })
    watcher.ingest(PTY, 'early https://app.example.com:3001/\n')
    watcher.bindPty(PTY, WORKTREE)

    const internals = watcher as unknown as { ptyToWorktree: Map<string, string> }
    const originalSet = internals.ptyToWorktree.set
    const setSpy = vi.fn(originalSet.bind(internals.ptyToWorktree))
    internals.ptyToWorktree.set = setSpy
    try {
      watcher.bindPty(PTY, WORKTREE)
    } finally {
      internals.ptyToWorktree.set = originalSet
    }

    expect(setSpy).not.toHaveBeenCalled()
    expect(watcher.lookup(WORKTREE, 3001)?.host).toBe('app.example.com')
  })

  it('unbindPty drops buffered state for the PTY', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'cached https://cached.example.com:3002/\n')
    watcher.ingest(PTY, 'partial https://example.com:3001') // no newline → buffered
    const events: { worktreeId: string; port: number }[] = []
    watcher.onDidChange((event) => events.push(event))
    watcher.unbindPty(PTY)
    // After unbind, the buffer is gone, so a completing chunk on a fresh
    // binding would have to repeat the URL.
    watcher.bindPty(PTY, WORKTREE)
    watcher.ingest(PTY, '/now\n')
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    expect(watcher.lookupBest([WORKTREE], 3002)).toBeUndefined()
    expect(events).toContainEqual({ worktreeId: WORKTREE, port: 3002 })
  })

  it('forgetWorktree drops scan snapshots, PTY buffers, and cached URLs', () => {
    const watcher = bindFresh()
    watcher.reconcileScan([WORKTREE], [{ port: 3001, pid: 100 }])
    watcher.ingest(PTY, 'cached https://cached.example.com:3001/\n')
    watcher.ingest(PTY, 'partial https://example.com:3002')
    const events: { worktreeId: string; port: number }[] = []
    watcher.onDidChange((event) => events.push(event))

    watcher.forgetWorktree(WORKTREE)

    const internals = watcher as unknown as {
      buffers: Map<string, unknown>
      ptyToWorktree: Map<string, string>
      scanSnapshots: Map<string, Map<number, number | undefined>>
    }
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    expect(internals.buffers.has(PTY)).toBe(false)
    expect(internals.ptyToWorktree.has(PTY)).toBe(false)
    expect(internals.scanSnapshots.has(WORKTREE)).toBe(false)
    expect(events).toEqual([{ worktreeId: WORKTREE, port: 3001 }])
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
    const events: { worktreeId: string; port: number }[] = []
    watcher.onDidChange((event) => events.push(event))
    watcher.ingest(PTY, 'C: https://c.example.com:3003/\n', 300)
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
    expect(watcher.lookup(WORKTREE, 3002)?.host).toBe('b.example.com')
    expect(watcher.lookup(WORKTREE, 3003)?.host).toBe('c.example.com')
    expect(events).toEqual([
      { worktreeId: WORKTREE, port: 3001 },
      { worktreeId: WORKTREE, port: 3003 }
    ])
  })

  it('invalidate drops one cache entry', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    watcher.invalidate(WORKTREE, 3001)
    expect(watcher.lookup(WORKTREE, 3001)).toBeUndefined()
  })

  it('rejects wildcard advertised hosts so they cannot override connectHost', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'Listening on http://0.0.0.0:3000/\n')
    watcher.ingest(PTY, 'Listening on http://[::]:3000/\n')
    expect(watcher.lookup(WORKTREE, 3000)).toBeUndefined()
  })

  it('notifies listeners when the visible advertised URL changes', () => {
    const watcher = bindFresh()
    const events: { worktreeId: string; port: number }[] = []
    const unsubscribe = watcher.onDidChange((event) => events.push(event))

    watcher.ingest(PTY, 'Local: http://localhost:3001/\n')
    watcher.ingest(PTY, 'Network: https://custom.example.com:3001/\n')
    watcher.ingest(PTY, 'Local: http://localhost:3001/\n')
    unsubscribe()
    watcher.ingest(PTY, 'Network: https://other.example.com:3001/\n')

    expect(events).toEqual([
      { worktreeId: WORKTREE, port: 3001 },
      { worktreeId: WORKTREE, port: 3001 }
    ])
  })

  it('caps the pre-bind pending buffer at 32 distinct PTY IDs', () => {
    const watcher = new AdvertisedUrlWatcher({ now: () => 1_000 })
    // 33 distinct unbound IDs; the first should be evicted before bind.
    for (let i = 0; i < 33; i++) {
      watcher.ingest(`pty-${i}`, `https://h${i}.example.com:300${i % 10}/\n`)
    }
    // Bind the first ID now; if it was evicted (LRU), no URL should appear.
    watcher.bindPty('pty-0', WORKTREE)
    expect(watcher.lookup(WORKTREE, 3000)).toBeUndefined()
    // Bind the most-recent ID; its pending data must still be there.
    watcher.bindPty('pty-32', WORKTREE)
    expect(watcher.lookup(WORKTREE, 3002)?.host).toBe('h32.example.com')
  })
})

describe('AdvertisedUrlWatcher.lookupBest', () => {
  it('returns undefined when no worktree has the port cached', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    expect(watcher.lookupBest(['repo::/other'], 3001)).toBeUndefined()
  })

  it('returns the only entry when one worktree has it', () => {
    const watcher = bindFresh()
    watcher.ingest(PTY, 'A: https://a.example.com:3001/\n')
    expect(watcher.lookupBest([WORKTREE], 3001)?.host).toBe('a.example.com')
  })

  it('picks the best entry across worktrees by hostKind', () => {
    const watcher = bindFresh()
    watcher.bindPty('pty-2', 'repo::/wt2')
    watcher.ingest(PTY, 'A: http://localhost:3001/\n')
    watcher.ingest('pty-2', 'B: https://custom.example.com:3001/\n')
    const best = watcher.lookupBest([WORKTREE, 'repo::/wt2'], 3001)
    expect(best?.host).toBe('custom.example.com')
  })
})
