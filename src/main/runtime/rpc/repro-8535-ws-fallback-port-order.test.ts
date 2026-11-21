/**
 * Issue #8535 — pinned `orca serve --port <P>` overridden by stale mobile-ws fallback.
 *
 * WebSocketTransport binds persisted fallback BEFORE preferred port so old paired
 * devices stay reachable (STA-1511). Side effect: an explicit --port is never tried
 * first when mobile-ws-fallback-port.json names a different port.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/runtime/rpc/repro-8535-ws-fallback-port-order.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pure mirror of the candidate-port order in WebSocketTransport.start
 * (src/main/runtime/rpc/ws-transport.ts). Kept local so the test fails if the
 * source order comment/logic diverges without updating this contract.
 */
export function candidatePortsForServe(preferredPort: number, fallbackPort?: number): number[] {
  const persistedFallbackPort =
    fallbackPort !== undefined && fallbackPort !== 0 && fallbackPort !== preferredPort
      ? fallbackPort
      : undefined
  return persistedFallbackPort !== undefined
    ? [persistedFallbackPort, preferredPort]
    : [preferredPort]
}

describe('issue #8535 serve port vs mobile-ws fallback', () => {
  it('binds stale fallback before explicitly preferred port', () => {
    // User: orca serve --port 6768, but userData has fallback 49152 from an earlier EADDRINUSE.
    expect(candidatePortsForServe(6768, 49152)).toEqual([49152, 6768])
  })

  it('does not insert fallback when equal to preferred or zero', () => {
    expect(candidatePortsForServe(6768, 6768)).toEqual([6768])
    expect(candidatePortsForServe(6768, 0)).toEqual([6768])
    expect(candidatePortsForServe(6768, undefined)).toEqual([6768])
  })

  it('source still documents bind-fallback-first order', () => {
    const src = readFileSync(join(__dirname, 'ws-transport.ts'), 'utf8')
    expect(src).toMatch(/persisted fallback port is bound FIRST/)
    expect(src).toMatch(/\[persistedFallbackPort, this\.port\]/)
  })
})
