import { describe, expect, it } from 'vitest'
import type { DetectedPort, PortForwardEntry } from '../../shared/ssh-types'
import {
  enrichSshDetectedPorts,
  enrichSshForwardEntries,
  getConnectionIdsForWorktree,
  getWorktreeIdsForConnection
} from './ssh-advertised-url-enrichment'
import { AdvertisedUrlWatcher, type AdvertisedUrl } from './advertised-url-watcher'

function watcherWith(
  entries: Record<string, Partial<AdvertisedUrl>>
): Pick<AdvertisedUrlWatcher, 'lookupBest' | 'reconcileScan'> {
  return {
    reconcileScan: () => {},
    lookupBest(worktreeIds, port): AdvertisedUrl | undefined {
      // Why: tests pin URLs to worktreeId+port via the entries map; whichever
      // worktree appears first in the request wins to keep assertions explicit.
      for (const wt of worktreeIds) {
        const hit = entries[`${wt}::${port}`]
        if (hit) {
          return {
            origin: hit.origin ?? 'http://x:1',
            host: hit.host ?? 'x',
            hostKind: hit.hostKind ?? 'custom',
            protocol: hit.protocol ?? 'http',
            port,
            ptyId: 'pty',
            lastSeenAt: 0
          }
        }
      }
      return undefined
    }
  }
}

describe('getConnectionIdsForWorktree', () => {
  it('maps a watcher worktreeId back to its SSH connection', () => {
    const store = {
      getRepos: () => [{ id: 'local-repo' }, { id: 'remote-repo', connectionId: 'ssh-1' }]
    } as Parameters<typeof getConnectionIdsForWorktree>[0]

    expect(getConnectionIdsForWorktree(store, 'remote-repo::/repo')).toEqual(['ssh-1'])
    expect(getConnectionIdsForWorktree(store, 'local-repo::/repo')).toEqual([])
    expect(getConnectionIdsForWorktree(store, 'invalid')).toEqual([])
  })
})

describe('getWorktreeIdsForConnection', () => {
  it('maps an SSH connection to every attached worktree', () => {
    const store = {
      getRepos: () => [
        { id: 'local-repo' },
        { id: 'remote-repo', connectionId: 'ssh-1' },
        { id: 'other-remote', connectionId: 'ssh-2' }
      ],
      getAllWorktreeMeta: () => ({
        'remote-repo::/repo': { displayName: 'repo' },
        'remote-repo::/repo/feature': { displayName: 'feature' },
        'other-remote::/repo': { displayName: 'other' },
        'local-repo::/repo': { displayName: 'local' },
        invalid: { displayName: 'invalid' }
      })
    } as unknown as Parameters<typeof getWorktreeIdsForConnection>[0]

    expect(getWorktreeIdsForConnection(store, 'ssh-1').sort()).toEqual([
      'remote-repo::/repo',
      'remote-repo::/repo/feature'
    ])
  })
})

describe('enrichSshForwardEntries', () => {
  it('returns input untouched when there are no worktrees', () => {
    const entries: PortForwardEntry[] = [
      { id: 'a', connectionId: 'conn', localPort: 53001, remoteHost: 'h', remotePort: 3001 }
    ]
    expect(enrichSshForwardEntries(entries, [], watcherWith({}))).toEqual(entries)
  })

  it('attaches advertisedUrl + protocol for entries whose remotePort matches', () => {
    const watcher = watcherWith({
      'wt::3001': {
        origin: 'https://custom.example.com:3001',
        host: 'custom.example.com',
        protocol: 'https'
      }
    })
    const entries: PortForwardEntry[] = [
      { id: 'a', connectionId: 'conn', localPort: 53001, remoteHost: 'h', remotePort: 3001 },
      { id: 'b', connectionId: 'conn', localPort: 53002, remoteHost: 'h', remotePort: 3002 }
    ]
    const enriched = enrichSshForwardEntries(entries, ['wt'], watcher)
    expect(enriched[0].advertisedUrl).toBe('https://custom.example.com:3001')
    expect(enriched[0].advertisedProtocol).toBe('https')
    expect(enriched[1].advertisedUrl).toBeUndefined()
  })

  it('does not mutate the input array entries', () => {
    const watcher = watcherWith({ 'wt::3001': { origin: 'http://x:3001', protocol: 'http' } })
    const entries: PortForwardEntry[] = [
      { id: 'a', connectionId: 'conn', localPort: 53001, remoteHost: 'h', remotePort: 3001 }
    ]
    enrichSshForwardEntries(entries, ['wt'], watcher)
    expect(entries[0].advertisedUrl).toBeUndefined()
  })
})

describe('enrichSshDetectedPorts', () => {
  it('reconciles an empty scan before returning unchanged ports', () => {
    const calls: unknown[][] = []
    const watcher = {
      reconcileScan(...args: Parameters<AdvertisedUrlWatcher['reconcileScan']>): void {
        calls.push(['reconcile', ...args])
      },
      lookupBest(...args: Parameters<AdvertisedUrlWatcher['lookupBest']>): AdvertisedUrl {
        calls.push(['lookupBest', ...args])
        return {
          origin: 'https://local.example.com:3001',
          host: 'local.example.com',
          hostKind: 'custom',
          protocol: 'https',
          port: 3001,
          ptyId: 'pty',
          lastSeenAt: 0
        }
      }
    }

    expect(enrichSshDetectedPorts([], ['wt'], watcher)).toEqual([])
    expect(calls).toEqual([['reconcile', ['wt'], []]])
  })

  it('attaches advertisedUrl when a worktree has a cached match', () => {
    const watcher = watcherWith({
      'wt::3001': {
        origin: 'https://local.example.com:3001',
        host: 'local.example.com',
        protocol: 'https'
      }
    })
    const ports: DetectedPort[] = [
      { port: 3001, host: '127.0.0.1', processName: 'node' },
      { port: 3002, host: '0.0.0.0' }
    ]
    const enriched = enrichSshDetectedPorts(ports, ['wt'], watcher)
    expect(enriched[0].advertisedUrl).toBe('https://local.example.com:3001')
    expect(enriched[0].advertisedProtocol).toBe('https')
    expect(enriched[1].advertisedUrl).toBeUndefined()
  })

  it('passes detected listener PID through to watcher lookup', () => {
    const calls: unknown[][] = []
    const watcher = {
      reconcileScan(...args: Parameters<AdvertisedUrlWatcher['reconcileScan']>): void {
        calls.push(['reconcile', ...args])
      },
      lookupBest(...args: Parameters<AdvertisedUrlWatcher['lookupBest']>): AdvertisedUrl {
        calls.push(['lookupBest', ...args])
        return {
          origin: 'https://local.example.com:3001',
          host: 'local.example.com',
          hostKind: 'custom',
          protocol: 'https',
          port: 3001,
          ptyId: 'pty',
          lastSeenAt: 0
        }
      }
    }

    enrichSshDetectedPorts(
      [{ port: 3001, host: '127.0.0.1', pid: 4242, processName: 'node' }],
      ['wt'],
      watcher
    )

    expect(calls).toEqual([
      ['reconcile', ['wt'], [{ port: 3001, pid: 4242 }]],
      ['lookupBest', ['wt'], 3001, 4242]
    ])
  })

  it('skips advertised enrichment when one port maps to multiple listener PIDs', () => {
    const calls: unknown[][] = []
    const watcher = {
      reconcileScan(...args: Parameters<AdvertisedUrlWatcher['reconcileScan']>): void {
        calls.push(['reconcile', ...args])
      },
      lookupBest(...args: Parameters<AdvertisedUrlWatcher['lookupBest']>): AdvertisedUrl {
        calls.push(['lookupBest', ...args])
        return {
          origin: 'https://local.example.com:3001',
          host: 'local.example.com',
          hostKind: 'custom',
          protocol: 'https',
          port: 3001,
          ptyId: 'pty',
          lastSeenAt: 0
        }
      }
    }

    const enriched = enrichSshDetectedPorts(
      [
        { port: 3001, host: '127.0.0.1', pid: 1111, processName: 'node' },
        { port: 3001, host: '127.0.0.2', pid: 2222, processName: 'node' }
      ],
      ['wt'],
      watcher
    )

    expect(enriched.every((port) => port.advertisedUrl === undefined)).toBe(true)
    expect(calls).toEqual([
      [
        'reconcile',
        ['wt'],
        [
          { port: 3001, pid: 1111 },
          { port: 3001, pid: 2222 }
        ]
      ]
    ])
  })

  it('still enriches duplicate host rows when the port has one unique PID', () => {
    const calls: unknown[][] = []
    const watcher = {
      reconcileScan(...args: Parameters<AdvertisedUrlWatcher['reconcileScan']>): void {
        calls.push(['reconcile', ...args])
      },
      lookupBest(...args: Parameters<AdvertisedUrlWatcher['lookupBest']>): AdvertisedUrl {
        calls.push(['lookupBest', ...args])
        return {
          origin: 'https://local.example.com:3001',
          host: 'local.example.com',
          hostKind: 'custom',
          protocol: 'https',
          port: 3001,
          ptyId: 'pty',
          lastSeenAt: 0
        }
      }
    }

    const enriched = enrichSshDetectedPorts(
      [
        { port: 3001, host: '127.0.0.1', pid: 4242, processName: 'node' },
        { port: 3001, host: '::1', pid: 4242, processName: 'node' }
      ],
      ['wt'],
      watcher
    )

    expect(enriched.every((port) => port.advertisedUrl === 'https://local.example.com:3001')).toBe(
      true
    )
    expect(calls).toEqual([
      [
        'reconcile',
        ['wt'],
        [
          { port: 3001, pid: 4242 },
          { port: 3001, pid: 4242 }
        ]
      ],
      ['lookupBest', ['wt'], 3001, 4242],
      ['lookupBest', ['wt'], 3001, 4242]
    ])
  })

  it('can enrich cached scanner rows without validating their PID', () => {
    const calls: unknown[][] = []
    const watcher = {
      reconcileScan(...args: Parameters<AdvertisedUrlWatcher['reconcileScan']>): void {
        calls.push(['reconcile', ...args])
      },
      lookupBest(...args: Parameters<AdvertisedUrlWatcher['lookupBest']>): AdvertisedUrl {
        calls.push(['lookupBest', ...args])
        return {
          origin: 'https://local.example.com:3001',
          host: 'local.example.com',
          hostKind: 'custom',
          protocol: 'https',
          port: 3001,
          ptyId: 'pty',
          lastSeenAt: 0
        }
      }
    }

    const enriched = enrichSshDetectedPorts(
      [{ port: 3001, host: '127.0.0.1', pid: 4242, processName: 'node' }],
      ['wt'],
      watcher,
      { validatePid: false }
    )

    expect(calls).toEqual([['lookupBest', ['wt'], 3001, undefined]])
    expect(enriched[0].pid).toBe(4242)
    expect(enriched[0].advertisedUrl).toBe('https://local.example.com:3001')
  })

  it('does not reconcile cached scanner rows during watcher-triggered refreshes', () => {
    const watcher = new AdvertisedUrlWatcher()
    watcher.bindPty('pty-1', 'wt')
    watcher.ingest('pty-1', 'ready at https://local.example.com:3001/\n')

    expect(enrichSshDetectedPorts([], ['wt'], watcher, { validatePid: false })).toEqual([])
    expect(watcher.lookupBest(['wt'], 3001)?.origin).toBe('https://local.example.com:3001')
  })
})
