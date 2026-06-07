const DEFAULT_PROCESS_GONE_DEDUPE_WINDOW_MS = 2_000
const DEFAULT_PROCESS_GONE_DEDUPE_MAX_KEYS = 128
const DEFAULT_PROCESS_GONE_INCIDENT_WINDOW_MS = 5 * 60_000
const DEFAULT_PROCESS_GONE_INCIDENT_MAX_KEYS = 128

const INCIDENT_DEDUPE_RENDERER_REASONS = new Set(['oom', 'killed'])

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

type ProcessGoneIncidentInput = {
  source: 'renderer' | 'child'
  processType: string
  reason: string
  exitCode: number | null
  details: Record<string, unknown>
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function getProcessGoneIncidentDedupeKey({
  source,
  processType,
  reason,
  exitCode,
  details
}: ProcessGoneIncidentInput): string | null {
  if (source !== 'renderer' || !INCIDENT_DEDUPE_RENDERER_REASONS.has(reason)) {
    return null
  }
  const webContentsId = finiteNumber(details.webContentsId)
  if (webContentsId !== null && webContentsId > 0) {
    return [source, processType, reason, exitCode ?? 'null', `wc:${webContentsId}`].join(':')
  }
  const largestPid = finiteNumber(details.processMetricsLargestPid)
  if (largestPid === null || largestPid <= 0) {
    return null
  }
  return [source, processType, reason, exitCode ?? 'null', `largest:${largestPid}`].join(':')
}

export class ProcessGoneIncidentDedupe {
  private readonly eventDedupe: ProcessGoneDedupe

  constructor(options: ProcessGoneDedupeOptions = {}) {
    this.eventDedupe = new ProcessGoneDedupe({
      windowMs: options.windowMs ?? DEFAULT_PROCESS_GONE_INCIDENT_WINDOW_MS,
      maxKeys: options.maxKeys ?? DEFAULT_PROCESS_GONE_INCIDENT_MAX_KEYS
    })
  }

  shouldRecord(input: ProcessGoneIncidentInput, now = Date.now()): boolean {
    const key = getProcessGoneIncidentDedupeKey(input)
    return key === null || this.eventDedupe.shouldRecord(key, now)
  }

  get size(): number {
    return this.eventDedupe.size
  }
}

export const processGoneDedupe = new ProcessGoneDedupe()
export const processGoneIncidentDedupe = new ProcessGoneIncidentDedupe()
