const DEFAULT_PROCESS_GONE_DEDUPE_WINDOW_MS = 2_000
const DEFAULT_PROCESS_GONE_DEDUPE_MAX_KEYS = 128

type ProcessGoneDedupeOptions = {
  windowMs?: number
  maxKeys?: number
}

export type ProcessGoneDedupeClaim = {
  readonly key: string
}

type ProcessGoneDedupeEntry = {
  readonly recordedAt: number
  readonly claim: ProcessGoneDedupeClaim
}

export class ProcessGoneDedupe {
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly recentKeys = new Map<string, ProcessGoneDedupeEntry>()

  constructor(options: ProcessGoneDedupeOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_PROCESS_GONE_DEDUPE_WINDOW_MS
    this.maxKeys = options.maxKeys ?? DEFAULT_PROCESS_GONE_DEDUPE_MAX_KEYS
  }

  shouldRecord(key: string, now = Date.now()): boolean {
    return this.tryClaim(key, now) !== null
  }

  tryClaim(key: string, now = Date.now()): ProcessGoneDedupeClaim | null {
    this.prune(now)

    const previous = this.recentKeys.get(key)
    if (previous && now - previous.recordedAt < this.windowMs) {
      return null
    }

    const claim = { key }
    // Refresh insertion order so capacity eviction removes the oldest claim.
    this.recentKeys.delete(key)
    this.recentKeys.set(key, { recordedAt: now, claim })
    this.prune(now)
    return claim
  }

  release(claim: ProcessGoneDedupeClaim): void {
    const current = this.recentKeys.get(claim.key)
    // A failed old write must not release a newer claim for the same key.
    if (current?.claim === claim) {
      this.recentKeys.delete(claim.key)
    }
  }

  get size(): number {
    return this.recentKeys.size
  }

  private prune(now: number): void {
    for (const [key, entry] of this.recentKeys) {
      if (now - entry.recordedAt >= this.windowMs) {
        this.recentKeys.delete(key)
      }
    }

    while (this.recentKeys.size > this.maxKeys) {
      const oldest = this.recentKeys.keys().next()
      if (oldest.done) {
        break
      }
      this.recentKeys.delete(oldest.value)
    }
  }
}

export function getProcessGoneDedupeKey(
  source: 'renderer' | 'child',
  processType: string,
  reason: string,
  exitCode: number | null,
  webContentsId?: number
): string {
  // One renderer death may produce several reasons; dedupe it by renderer identity.
  if (source === 'renderer') {
    return `${source}:${processType}:${webContentsId ?? 'global'}`
  }
  return `${source}:${processType}:${reason}:${exitCode ?? 'null'}`
}

export const processGoneDedupe = new ProcessGoneDedupe()
