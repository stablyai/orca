import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatSites, scanWebSocketServerBinds } from './websocket-server-bind-scan'

// Require explicit WebSocket bind host tree-wide; ws {port} silently binds wildcard unlike established .listen convention. Allowlist only shrinks.
/** The ratchet, held as data so it reads as the list it is. */
const WILDCARD_BIND_ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'websocket-server-wildcard-bind-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

// Only lower count after pinning a host; raising it is never a fix.
const WILDCARD_BIND_PIN = 1

// Pin recognized construction floor so broken scanner cannot pass after finding zero offenders.
const RECOGNIZED_CONSTRUCTION_FLOOR = 20

describe('WebSocketServer loopback bind boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..')
  const scan = scanWebSocketServerBinds(repoRoot)
  const offenders = scan.wildcardBound.map((site) => site.path)

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(scan.filesScanned).toBeGreaterThan(5_000)
  })

  it('still recognizes the known construction sites', () => {
    expect(
      scan.constructions,
      `Only ${scan.constructions} WebSocketServer constructions were recognized; the floor is ` +
        `${RECOGNIZED_CONSTRUCTION_FLOOR}. The scanner has probably stopped following an import ` +
        'shape rather than the tree having lost that many servers.'
    ).toBeGreaterThanOrEqual(RECOGNIZED_CONSTRUCTION_FLOOR)
  })

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

  it('holds the wildcard-bind count at the pin', () => {
    // Use literal cap independent of allowlist length so widening requires another visible edit.
    expect(
      scan.wildcardBound.length,
      `${scan.wildcardBound.length} constructions bind the wildcard; the pin is ` +
        `${WILDCARD_BIND_PIN}. Never raise the pin -- pass host: '127.0.0.1' instead.`
    ).toBeLessThanOrEqual(WILDCARD_BIND_PIN)
    // Prune unused allowance or ratchet grants free room for next wildcard bind.
    expect(
      scan.wildcardBound.length,
      `Only ${scan.wildcardBound.length} constructions bind the wildcard. Lower ` +
        `WILDCARD_BIND_PIN to ${scan.wildcardBound.length} to keep the ground you just took.`
    ).toBeGreaterThanOrEqual(WILDCARD_BIND_PIN)
  })
})
