import { compareAppVersions } from '../../shared/app-version'

// Real-CLI-verified floors, capped to their major: a new major may change the model route.
const LEGACY_FLAG_MODEL_FLOOR = '1.18.30'
const CONFIG_OVERLAY_MODEL_FLOOR = '2.0.14'

function isStableReleaseFrom(version: string | null | undefined, floor: string): boolean {
  const major = floor.split('.')[0]
  return (
    typeof version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    version.split('.')[0] === major &&
    compareAppVersions(version, floor) >= 0
  )
}

export function isVerifiedOpenCodeLegacyModelVersion(version: string | null | undefined): boolean {
  return isStableReleaseFrom(version, LEGACY_FLAG_MODEL_FLOOR)
}

export function isVerifiedOpenCodeConfigModelVersion(version: string | null | undefined): boolean {
  return isStableReleaseFrom(version, CONFIG_OVERLAY_MODEL_FLOOR)
}
