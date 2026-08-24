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
    // Why: process-gone tuples come from Electron and can vary by exit code;
    // keep the short dedupe window without retaining stale tuples forever.
    this.recentKeys.delete(key)
    this.recentKeys.set(key, { recordedAt: now, claim })
    this.prune(now)
    return claim
  }

  release(claim: ProcessGoneDedupeClaim): void {
    const current = this.recentKeys.get(claim.key)
    // Why: an old failed write must not erase a newer claim for the same
    // renderer after the dedupe window expires or bounded entries are evicted.
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
  rendererProcessId?: number | null
): string {
  // Why: one renderer death can surface as crashed/oom/launch-failed in a
  // burst. Coalesce that prompt noise per renderer process — concurrent deaths
  // of distinct renderers (main window + browser guests, #15052) must each
  // report — while keeping child identities precise. The identity is the
  // render-process-host id, not the webContents id: several webContents can
  // share one OS renderer process (same-site popups, #15063), and keying on
  // webContents filed one report per observer of a single death.
  if (source === 'renderer') {
    // Why: an unreadable identity (webContents destroyed mid-event) buckets as
    // 'unknown'. Every observation of one death goes unreadable together, so
    // its burst still coalesces; collapsing two distinct concurrent deaths
    // would need both unreadable inside the 2s window — degrading to the
    // pre-#15052 missed-report, never to the duplicate noise #14667 removed.
    return `${source}:${processType}:rph:${rendererProcessId ?? 'unknown'}`
  }
  return `${source}:${processType}:${reason}:${exitCode ?? 'null'}`
}

export const processGoneDedupe = new ProcessGoneDedupe()
