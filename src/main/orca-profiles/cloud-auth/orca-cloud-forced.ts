import { cloudAvailableByBuild } from '../../cloud-build-defaults'

// Orca Cloud entry points follow the account's `cloud.available` capability (server allowlist),
// except where the build or run decides: ORCA_CLOUD_AVAILABLE=0/1 wins (tests, screenshots), and
// dev runs, runs pointed at another auth server (ORCA_CLOUD_API_URL: e2e, staging) and internal
// builds (allowDevSigning baked in config/cloud-build-defaults.json) always show it. null: follow the
// capability.
export function forcedOrcaCloudAvailability(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  internalBuild: boolean = cloudAvailableByBuild()
): boolean | null {
  const override = env.ORCA_CLOUD_AVAILABLE?.trim()
  if (override === '1') {
    return true
  }
  if (override === '0') {
    return false
  }
  if (!packaged || env.ORCA_CLOUD_API_URL?.trim() || internalBuild) {
    return true
  }
  return null
}
