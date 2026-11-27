import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseObject(line: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** Of the waiting requests, those asking to start an item: the item each would start, by key. */
export class ProviderRelayStartApprovals {
  private readonly starting = new Map<string, string>()
  private readonly counts = new Map<string, number>()
  /** Request methods that ask to start an item (from the detach policy). */
  private methods: ReadonlySet<string> = new Set()

  /** A policy naming other start methods reclassifies the requests already held (a rare change). */
  setMethods(methods: readonly string[], held: ReadonlyMap<string, ProviderRelayRecord>): void {
    const next = new Set(methods)
    if (next.size === this.methods.size && methods.every((m) => this.methods.has(m))) {
      return
    }
    this.methods = next
    this.clear()
    for (const [key, { line }] of held) {
      const message = parseObject(line)
      if (message && typeof message.method === 'string') {
        this.hold(key, message.method, message.params)
      }
    }
  }

  /** A whole-item start approval names the item; one with an `approvalId` targets a running one. */
  hold(key: string, method: string, params: unknown): void {
    if (!this.methods.has(method) || !isObject(params) || params.approvalId !== undefined) {
      return
    }
    if (typeof params.itemId === 'string') {
      this.starting.set(key, params.itemId)
      this.counts.set(params.itemId, (this.counts.get(params.itemId) ?? 0) + 1)
    }
  }

  release(key: string): void {
    const item = this.starting.get(key)
    if (item === undefined) {
      return
    }
    this.starting.delete(key)
    const count = (this.counts.get(item) ?? 1) - 1
    if (count > 0) {
      this.counts.set(item, count)
    } else {
      this.counts.delete(item)
    }
  }

  /** True while a waiting request asks to start this item: it hasn't started running. */
  awaits(itemId: string): boolean {
    return this.counts.has(itemId)
  }

  clear(): void {
    this.starting.clear()
    this.counts.clear()
  }
}
