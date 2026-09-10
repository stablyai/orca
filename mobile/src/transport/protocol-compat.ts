// evaluateCompat mirrors the shared evaluator, absent-field handling included; the mobile
// status probe only adds a third outcome, for a status payload it cannot read at all.
import { MIN_COMPATIBLE_DESKTOP_VERSION, MOBILE_PROTOCOL_VERSION } from './protocol-version'

export type CompatVerdict =
  | { kind: 'ok' }
  | { kind: 'unknown' }
  | {
      kind: 'blocked'
      reason: 'mobile-too-old' | 'desktop-too-old'
      desktopVersion: number
      requiredMobileVersion?: number
      requiredDesktopVersion?: number
    }

export function evaluateCompat(input: {
  desktopProtocolVersion: number | undefined
  desktopMinCompatibleMobileVersion: number | undefined
}): CompatVerdict {
  const desktopVersion = input.desktopProtocolVersion ?? 0
  const requiredMobile = input.desktopMinCompatibleMobileVersion ?? 0

  if (MOBILE_PROTOCOL_VERSION < requiredMobile) {
    return {
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion,
      requiredMobileVersion: requiredMobile
    }
  }
  if (desktopVersion < MIN_COMPATIBLE_DESKTOP_VERSION) {
    return {
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion,
      requiredDesktopVersion: MIN_COMPATIBLE_DESKTOP_VERSION
    }
  }
  return { kind: 'ok' }
}

// Absent reads as 0, matching the shared evaluator: a desktop old enough to omit the field
// is fenced by MIN_COMPATIBLE_DESKTOP_VERSION and told to update, which is actionable.
// Only a field that is present and unreadable leaves the verdict unknown.
function readProtocolField(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 0
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function readHostProtocolVerdict(status: unknown): CompatVerdict {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return { kind: 'unknown' }
  }
  const fields = status as Record<string, unknown>
  const version = readProtocolField(fields.protocolVersion)
  const minimum = readProtocolField(fields.minCompatibleMobileVersion)
  if (version === null || minimum === null) {
    return { kind: 'unknown' }
  }
  return evaluateCompat({
    desktopProtocolVersion: version,
    desktopMinCompatibleMobileVersion: minimum
  })
}
