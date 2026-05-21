import { describe, expect, it } from 'vitest'
import type { DetectedPort, PortForwardEntry } from '../../shared/ssh-types'
import { enrichSshDetectedPorts, enrichSshForwardEntries } from './ssh-advertised-url-enrichment'
import type { AdvertisedUrl, AdvertisedUrlWatcher } from './advertised-url-watcher'

function watcherWith(
  entries: Record<string, Partial<AdvertisedUrl>>
): Pick<AdvertisedUrlWatcher, 'lookupBest'> {
  return {
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
})
