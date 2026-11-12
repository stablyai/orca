import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'
import { redactString } from '../observability/redactor'

export type HangFrame = { name: string; module: string; line?: number; column?: number }
export type HangStack = { frames: HangFrame[]; count: number; hot: boolean }
export type HangStacks = {
  stacks: HangStack[]
  samples: number
  validSamples: number
  truncated: boolean
}
export type MainJsCapture = HangStacks & {
  state: 'collecting' | 'stop-pending' | 'completed' | 'failed' | 'not-started'
  cleanup: 'pending' | 'drain-complete'
  samplingIntervalUs: number
  requestedCaptureMs: number
  budgetBasis: 'detection'
  stopReason?: 'recovery' | 'deadline' | 'shutdown'
  startPostedAfterDetectionMs?: number
  startAcknowledgedAfterDetectionMs?: number
  stopRequestedAfterDetectionMs?: number
  stopPostedAfterDetectionMs?: number
  stopAcknowledgedAfterDetectionMs?: number
  stopAckDelayMs?: number
  profileDurationMs?: number
  overlap: 'unconfirmed' | 'post-recovery'
}
export type NativeHangCapture = HangStacks & {
  state: 'collecting' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  mainThreadIdentified: boolean
  mainSectionComplete: boolean
  reportTruncated: boolean
  timedOut: boolean
  cleanup: 'pending' | 'terminated' | 'unverified'
  exitCode?: number
}

export const emptyHangStacks = (): HangStacks => ({
  stacks: [],
  samples: 0,
  validSamples: 0,
  truncated: false
})

export function hangLabel(value: unknown, limit = 96): string {
  // Reject whole oversized fields before redaction so a cut secret cannot escape matching.
  if (typeof value !== 'string' || value.length > 512) {
    return '<omitted>'
  }
  return sanitizeCrashReportString(redactString(value), limit).slice(0, limit)
}

export function hangModule(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    return '<unknown>'
  }
  const path = value.split(/[?#]/, 1)[0]
  const basename = path.split(/[/\\]/).at(-1) ?? ''
  return hangLabel(basename, 64)
}

export function topHangStacks(candidates: HangStack[], validSamples: number): HangStack[] {
  const top: HangStack[] = []
  for (const candidate of candidates) {
    if (!candidate.frames.length || candidate.count <= 0) {
      continue
    }
    const rank = top.findIndex((item) => item.count < candidate.count)
    if (rank !== -1) {
      top.splice(rank, 0, candidate)
    } else if (top.length < 3) {
      top.push(candidate)
    }
    if (top.length > 3) {
      top.pop()
    }
  }
  return top.map((item) => ({ ...item, hot: item.count > validSamples * 0.2 }))
}

export function parseHangStacks(value: unknown): HangStacks | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding branch excludes null and non-objects before reading unknown properties.
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.stacks) || data.stacks.length > 3) {
    return null
  }
  const stacks: HangStack[] = []
  for (const item of data.stacks) {
    if (
      !item ||
      !Array.isArray(item.frames) ||
      item.frames.length > 8 ||
      !Number.isSafeInteger(item.count) ||
      item.count <= 0
    ) {
      continue
    }
    const frames: HangFrame[] = []
    for (const frame of item.frames) {
      if (!frame || typeof frame.name !== 'string' || typeof frame.module !== 'string') {
        continue
      }
      frames.push({
        name: hangLabel(frame.name),
        module: hangLabel(frame.module, 64),
        ...(Number.isSafeInteger(frame.line) && frame.line >= 0 ? { line: frame.line } : {}),
        ...(Number.isSafeInteger(frame.column) && frame.column >= 0 ? { column: frame.column } : {})
      })
    }
    if (frames.length) {
      stacks.push({ frames, count: item.count, hot: false })
    }
  }
  const validSamples =
    typeof data.validSamples === 'number' &&
    Number.isSafeInteger(data.validSamples) &&
    data.validSamples >= 0
      ? data.validSamples
      : 0
  return {
    stacks: topHangStacks(stacks, validSamples),
    validSamples,
    samples:
      typeof data.samples === 'number' && Number.isSafeInteger(data.samples) && data.samples >= 0
        ? data.samples
        : 0,
    truncated: data.truncated === true
  }
}
