const DEFAULT_PROCESS_GONE_DEDUPE_WINDOW_MS = 2_000
const DEFAULT_PROCESS_GONE_DEDUPE_MAX_KEYS = 128

type ProcessGoneDedupeOptions = {
  windowMs?: number
  maxKeys?: number
}

export class ProcessGoneDedupe {
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly recentKeys = new Map<string, number>()

  constructor(options: ProcessGoneDedupeOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_PROCESS_GONE_DEDUPE_WINDOW_MS
    this.maxKeys = options.maxKeys ?? DEFAULT_PROCESS_GONE_DEDUPE_MAX_KEYS
  }

  shouldRecord(key: string, now = Date.now()): boolean {
    this.prune(now)

    const previous = this.recentKeys.get(key)
    if (previous !== undefined && now - previous < this.windowMs) {
      return false
    }

    // Why: process-gone tuples come from Electron and can vary by exit code;
    // keep the short dedupe window without retaining stale tuples forever.
    this.recentKeys.delete(key)
    this.recentKeys.set(key, now)
    this.prune(now)
    return true
  }

  get size(): number {
    return this.recentKeys.size
  }

  private prune(now: number): void {
    for (const [key, recordedAt] of this.recentKeys) {
      if (now - recordedAt >= this.windowMs) {
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
  processType: string,
  reason: string,
  exitCode: number | null
): string {
  return `${processType}:${reason}:${exitCode ?? 'null'}`
}

export const processGoneDedupe = new ProcessGoneDedupe()
