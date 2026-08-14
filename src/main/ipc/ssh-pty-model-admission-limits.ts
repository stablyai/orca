import type { SshPtyModelAdmissionOptions } from './ssh-pty-model-admission-contract'

export type SshPtyModelAdmissionLimits = Readonly<{
  perPtyHighSourceUnits: number
  perPtyHighBytes: number
  perPtyLowSourceUnits: number
  perPtyLowBytes: number
  globalHighSourceUnits: number
  globalHighBytes: number
  globalLowSourceUnits: number
  globalLowBytes: number
  pressureMaxFrames: number
  pressureMaxBytes: number
}>

const DEFAULT_PER_PTY_HIGH_SOURCE_UNITS = 256 * 1024
const DEFAULT_PER_PTY_HIGH_BYTES = 2 * 1024 * 1024
const DEFAULT_GLOBAL_HIGH_SOURCE_UNITS = 50 * DEFAULT_PER_PTY_HIGH_SOURCE_UNITS
const DEFAULT_GLOBAL_HIGH_BYTES = 64 * 1024 * 1024

export function resolveSshPtyModelAdmissionLimits(
  options: SshPtyModelAdmissionOptions
): SshPtyModelAdmissionLimits {
  const perPtyHighSourceUnits = options.perPtyHighSourceUnits ?? DEFAULT_PER_PTY_HIGH_SOURCE_UNITS
  const perPtyHighBytes = options.perPtyHighBytes ?? DEFAULT_PER_PTY_HIGH_BYTES
  return {
    perPtyHighSourceUnits,
    perPtyHighBytes,
    perPtyLowSourceUnits: options.perPtyLowSourceUnits ?? Math.floor(perPtyHighSourceUnits / 2),
    perPtyLowBytes: options.perPtyLowBytes ?? Math.floor(perPtyHighBytes / 2),
    globalHighSourceUnits: options.globalHighSourceUnits ?? DEFAULT_GLOBAL_HIGH_SOURCE_UNITS,
    globalHighBytes: options.globalHighBytes ?? DEFAULT_GLOBAL_HIGH_BYTES,
    globalLowSourceUnits: options.globalLowSourceUnits ?? 8 * 1024 * 1024,
    globalLowBytes: options.globalLowBytes ?? 48 * 1024 * 1024,
    pressureMaxFrames: options.pressureMaxFrames ?? 64,
    pressureMaxBytes: options.pressureMaxBytes ?? 1024 * 1024
  }
}
