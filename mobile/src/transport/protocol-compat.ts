// Why: this file mirrors src/shared/protocol-compat.ts (which is
// covered by CI vitest). Metro can't resolve out of mobile/, so the
// pure function is duplicated here. Keep the two files in sync — when
// you change the evaluator's logic, update both. The src/shared/ copy
// is the tested canonical version.
import { MIN_COMPATIBLE_DESKTOP_VERSION, MOBILE_PROTOCOL_VERSION } from './protocol-version'

export type CompatVerdict =
  | { kind: 'ok' }
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
