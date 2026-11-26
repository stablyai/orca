import { parseHangStacks, type MainJsCapture, type NativeHangCapture } from './hang-stacks'
import type { HangObservation } from './hang-observation-schema'

export function parseMainJsCapture(value: unknown): MainJsCapture | undefined {
  const stacks = parseHangStacks(value)
  if (!stacks || !value || typeof value !== 'object') {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding branch excludes null and non-objects before reading unknown properties.
  const data = value as Record<string, unknown>
  if (
    !['collecting', 'stop-pending', 'completed', 'failed', 'not-started'].includes(
      String(data.state)
    )
  ) {
    return undefined
  }
  const result: MainJsCapture = {
    ...stacks,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed state allowlist above validates this string union.
    state: data.state as MainJsCapture['state'],
    cleanup: data.cleanup === 'drain-complete' ? 'drain-complete' : 'pending',
    samplingIntervalUs: 10_000,
    requestedCaptureMs: 5_000,
    budgetBasis: 'detection',
    overlap: data.overlap === 'post-recovery' ? 'post-recovery' : 'unconfirmed'
  }
  for (const key of [
    'startPostedAfterDetectionMs',
    'startAcknowledgedAfterDetectionMs',
    'stopRequestedAfterDetectionMs',
    'stopPostedAfterDetectionMs',
    'stopAcknowledgedAfterDetectionMs',
    'stopAckDelayMs',
    'profileDurationMs'
  ] as const) {
    if (typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0) {
      result[key] = Math.min(data[key], Number.MAX_SAFE_INTEGER)
    }
  }
  if (['recovery', 'deadline', 'shutdown'].includes(String(data.stopReason))) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed stop-reason allowlist validates this value.
    result.stopReason = data.stopReason as MainJsCapture['stopReason']
  }
  return result
}

export function parseNativeHangCapture(value: unknown): NativeHangCapture | undefined {
  const stacks = parseHangStacks(value)
  if (!stacks || !value || typeof value !== 'object') {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preceding branch excludes null and non-objects before reading unknown properties.
  const data = value as Record<string, unknown>
  if (
    !['collecting', 'completed', 'failed'].includes(String(data.state)) ||
    typeof data.startedAt !== 'number' ||
    !Number.isFinite(data.startedAt) ||
    data.startedAt < 0
  ) {
    return undefined
  }
  return {
    ...stacks,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed state allowlist above validates this string union.
    state: data.state as NativeHangCapture['state'],
    startedAt: data.startedAt,
    ...(typeof data.completedAt === 'number' &&
    Number.isFinite(data.completedAt) &&
    data.completedAt >= data.startedAt
      ? { completedAt: data.completedAt }
      : {}),
    mainThreadIdentified: data.mainThreadIdentified === true,
    mainSectionComplete: data.mainSectionComplete === true,
    reportTruncated: data.reportTruncated === true,
    timedOut: data.timedOut === true,
    cleanup:
      data.cleanup === 'terminated'
        ? 'terminated'
        : data.cleanup === 'unverified'
          ? 'unverified'
          : 'pending',
    ...(typeof data.exitCode === 'number' && Number.isSafeInteger(data.exitCode)
      ? { exitCode: data.exitCode }
      : {})
  }
}

export function admitHangObservation(record: HangObservation): HangObservation {
  const candidate: HangObservation = {
    ...record,
    ...(record.mainJs ? { mainJs: structuredClone(record.mainJs) } : {}),
    ...(record.native ? { native: structuredClone(record.native) } : {})
  }
  const bytes = (): number => Buffer.byteLength(JSON.stringify(candidate))
  if (bytes() <= 7 * 1024) {
    return candidate
  }
  candidate.completedSpans = null
  for (const capture of [candidate.mainJs, candidate.native]) {
    if (!capture) {
      continue
    }
    while (bytes() > 7 * 1024 && capture.stacks.length > 1) {
      capture.stacks.pop()
      capture.truncated = true
    }
  }
  for (const capture of [candidate.mainJs, candidate.native]) {
    if (!capture) {
      continue
    }
    while (bytes() > 7 * 1024 && capture.stacks[0]?.frames.length > 1) {
      capture.stacks[0].frames.pop()
      capture.truncated = true
    }
    if (bytes() > 7 * 1024) {
      for (const stack of capture.stacks) {
        for (const frame of stack.frames) {
          frame.name = frame.name.slice(0, 24)
          frame.module = frame.module.slice(0, 24)
          capture.truncated = true
        }
      }
    }
  }
  return candidate
}
