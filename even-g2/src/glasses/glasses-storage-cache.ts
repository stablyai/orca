// Unit 2 — in-memory Map over GlassesBridge.get/setLocalStorage: read-through (cache
// misses fall through to the bridge) and write-through (writes hit the bridge before the
// cache is updated). '' means absent, matching GlassesBridge's storage contract — there is
// no delete, callers write '' (spec S4).
import type { GlassesBridge } from './glasses-bridge'

export class GlassesStorageCache {
  private readonly cache = new Map<string, string>()

  constructor(private readonly bridge: GlassesBridge) {}

  async get(key: string): Promise<string> {
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      return cached
    }
    const value = await this.bridge.getStoredValue(key)
    this.cache.set(key, value)
    return value
  }

  async set(key: string, value: string): Promise<boolean> {
    const ok = await this.bridge.setStoredValue(key, value)
    if (ok) {
      this.cache.set(key, value)
    }
    return ok
  }

  // '' means absent — same semantics as an empty-string write (no delete op exists).
  async remove(key: string): Promise<boolean> {
    return this.set(key, '')
  }

  // Synchronous presence check against whatever is currently cached (does not read through).
  hasCached(key: string): boolean {
    const cached = this.cache.get(key)
    return cached !== undefined && cached !== ''
  }

  invalidate(key: string): void {
    this.cache.delete(key)
  }
}
