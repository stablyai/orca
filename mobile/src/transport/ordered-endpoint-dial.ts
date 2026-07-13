/**
 * Ordered endpoint dial helpers for multi-network failover (KTD2–KTD4).
 * Dial preference lives here; host.endpoint is never rewritten to last-good (KTD9).
 */

export type DialOrderMode = 'cold' | 'reconnect'

/**
 * Build the endpoint walk for one connect/reconnect pass.
 * Cold: preferred order from index 0.
 * Reconnect with sticky: last-good first, then remaining preferred order.
 * After sticky is disabled (one last-good miss), reconnect uses preferred order only.
 */
export function buildDialOrder(args: {
  endpoints: readonly string[]
  lastGoodEndpoint?: string | null
  mode: DialOrderMode
  /** When false, reconnect walks preferred order only (leave-home after last-good miss). */
  stickyLastGood?: boolean
}): string[] {
  const preferred = dedupeNonEmpty(args.endpoints)
  if (preferred.length === 0) {
    return []
  }

  if (args.mode === 'cold' || args.stickyLastGood === false) {
    return preferred
  }

  const lastGood = args.lastGoodEndpoint?.trim()
  if (!lastGood || !preferred.includes(lastGood)) {
    return preferred
  }

  return [lastGood, ...preferred.filter((ep) => ep !== lastGood)]
}

/** Mutable walk state for one connect/reconnect ordered pass. */
export class OrderedDialPass {
  order: string[] = []
  index = 0
  active = false
  stickyLastGood = false
  lastGoodEndpoint: string | null = null
  authPinnedEndpoint: string | null = null

  begin(preferredEndpoints: readonly string[], mode: DialOrderMode): string {
    if (this.authPinnedEndpoint) {
      this.order = [this.authPinnedEndpoint]
    } else {
      this.order = buildDialOrder({
        endpoints: preferredEndpoints,
        lastGoodEndpoint: this.lastGoodEndpoint,
        mode,
        stickyLastGood: mode === 'reconnect' ? this.stickyLastGood : false
      })
    }
    this.index = 0
    this.active = true
    return this.order[0] ?? preferredEndpoints[0]!
  }

  // Why: one last-good miss disables sticky for the rest of this pass and later
  // passes until a different endpoint succeeds (leave-home recovery, KTD2).
  noteStickyMiss(): void {
    if (
      this.stickyLastGood &&
      this.lastGoodEndpoint &&
      this.order[this.index] === this.lastGoodEndpoint
    ) {
      this.stickyLastGood = false
    }
  }

  resolveOpenMode(lastConnectedAt: number | null, reconnectAttempt: number): DialOrderMode {
    return lastConnectedAt != null || reconnectAttempt > 0 || this.stickyLastGood
      ? 'reconnect'
      : 'cold'
  }

  activeOrFallback(preferredEndpoints: readonly string[]): string {
    return this.order[this.index] ?? preferredEndpoints[0]!
  }

  /** Advance to next endpoint in the pass, or null if exhausted. */
  advance(): string | null {
    this.noteStickyMiss()
    if (this.index + 1 >= this.order.length) {
      this.active = false
      return null
    }
    this.index++
    return this.order[this.index]!
  }

  markConnected(endpoint: string): void {
    this.lastGoodEndpoint = endpoint
    this.stickyLastGood = true
    this.authPinnedEndpoint = null
    this.active = false
  }

  pinAuth(endpoint: string): void {
    this.authPinnedEndpoint = endpoint
    this.active = false
  }

  clearAuthPin(): void {
    this.authPinnedEndpoint = null
  }

  endPass(): void {
    if (this.active) {
      this.noteStickyMiss()
    }
    this.active = false
  }
}

function dedupeNonEmpty(endpoints: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of endpoints) {
    const value = raw.trim()
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    out.push(value)
  }
  return out
}
