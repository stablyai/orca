import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatSites, scanWebSocketServerBinds } from './websocket-server-bind-scan'

// Require explicit WebSocket bind host tree-wide; ws {port} silently binds wildcard unlike established .listen convention. Allowlist only shrinks.
/** The ratchet, held as data so it reads as the list it is. */
const WILDCARD_BIND_ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, './fixtures', 'websocket-server-wildcard-bind-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

describe('WebSocketServer loopback bind boundary', () => {
  const repoRoot = resolve(__dirname, '../../..', '..')
  const scan = scanWebSocketServerBinds(repoRoot)
  const offenders = scan.wildcardBound.map((site) => site.path)

  it('can read the options of every construction it found', () => {
    // Opaque shapes may hide wildcard bind; rewrite plainly instead of treating unreadable as safe.
    expect(
      scan.opaque.map((site) => `${site.path}:${site.line} -- ${site.reason}`),
      'WebSocketServer options that this guard cannot read.'
    ).toEqual([])
  })

  it('has no wildcard-bound server outside the allowlist', () => {
    const unlisted = scan.wildcardBound.filter(
      (site) => !WILDCARD_BIND_ALLOWLIST.includes(site.path)
    )
    expect(
      formatSites(unlisted),
      "New WebSocketServer that binds a port without a host. Pass host: '127.0.0.1' so a foreign " +
        'loopback listener cannot claim the port and answer in its place.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    // Remove fixed allowlist entries or next regression at same path is hidden.
    const stale = WILDCARD_BIND_ALLOWLIST.filter((path) => !offenders.includes(path))
    expect(stale, 'Allowlist entry no longer binds the wildcard — delete the line.').toEqual([])
  })
})
