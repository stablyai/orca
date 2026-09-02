import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatSites, scanWebSocketServerBinds } from './websocket-server-bind-scan'

/**
 * Hold the bind address at the tree level rather than per call site.
 *
 * Every one of the ~30 `.listen(0, ...)` calls in this repo already passes
 * '127.0.0.1'; 7 of 7 `new WebSocketServer({ port })` calls did not. Authors know
 * the convention -- `ws` just never asks, because `{ port }` alone binds the
 * wildcard without a word. That silence is what this test replaces.
 *
 * The allowlist only shrinks. A new wildcard bind fails here even where it looks
 * harmless today, because harmless-looking is exactly what the seven were.
 */
/** The ratchet, held as data so it reads as the list it is. */
const WILDCARD_BIND_ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'websocket-server-wildcard-bind-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

/**
 * The true count of constructions that bind a port without pinning a host.
 *
 * May only ever be DECREASED, and only by pinning a host. Raising it is never
 * the fix.
 */
const WILDCARD_BIND_PIN = 1

/**
 * A floor under the constructions the scanner still recognizes.
 *
 * This is the guard against the scanner going blind: an import pattern it stops
 * following reports zero offenders and reads exactly like a clean tree. During
 * development a single wrong regex dropped this from 24 to 3.
 */
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
    // An unreadable shape is never assumed safe: it could be hiding a host, or
    // hiding the absence of one. Rewrite it as a plain object literal.
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
    // Why this direction matters too: an entry left behind after the file was
    // fixed hides the next regression in that same path.
    const stale = WILDCARD_BIND_ALLOWLIST.filter((path) => !offenders.includes(path))
    expect(stale, 'Allowlist entry no longer binds the wildcard — delete the line.').toEqual([])
  })

  it('holds the wildcard-bind count at the pin', () => {
    // Bounding by the allowlist's own length would prove nothing: the two move
    // together, so appending a line to silence a failure would keep the bound
    // satisfied. The pin is a literal so that widening takes a second edit.
    expect(
      scan.wildcardBound.length,
      `${scan.wildcardBound.length} constructions bind the wildcard; the pin is ` +
        `${WILDCARD_BIND_PIN}. Never raise the pin -- pass host: '127.0.0.1' instead.`
    ).toBeLessThanOrEqual(WILDCARD_BIND_PIN)
    // A pin left above reality is how a ratchet rots: it re-opens room for the
    // next wildcard bind to land for free.
    expect(
      scan.wildcardBound.length,
      `Only ${scan.wildcardBound.length} constructions bind the wildcard. Lower ` +
        `WILDCARD_BIND_PIN to ${scan.wildcardBound.length} to keep the ground you just took.`
    ).toBeGreaterThanOrEqual(WILDCARD_BIND_PIN)
  })
})
