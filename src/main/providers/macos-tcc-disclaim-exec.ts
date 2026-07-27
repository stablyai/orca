import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SHIM_EXECUTABLE = 'orca-tcc-disclaim-exec'

/**
 * Rollout flag for the disclaim exec shim (default off). Set to `1`/`true` to
 * replace the login(1) TCC-attribution wrap with the shim, which disclaims the
 * responsible-process link so each terminal program becomes its own responsible
 * process — tccd then keys grants to that program's own code identity instead
 * of Orca's (#9756), without dragging PAM into every spawn.
 */
const ENABLE_ENV_VAR = 'ORCA_MACOS_TCC_DISCLAIM'

let cachedShimPath: string | null | undefined

function isEnabledByEnv(): boolean {
  const value = process.env[ENABLE_ENV_VAR]
  return value === '1' || value === 'true'
}

/**
 * Resolves the disclaim exec shim binary, or null when the wrap should keep
 * today's login(1) path: flag off (the default), non-macOS, or shim absent.
 *
 * Packaged and dev app bundles both place the shim beside the executable in
 * Contents/MacOS (extraFiles / the dev runner copy), mirroring how the
 * notification-status helper is resolved; the .build path covers processes
 * launched from a bare checkout.
 */
export function resolveMacosTccDisclaimShimPath(): string | null {
  if (process.platform !== 'darwin' || !isEnabledByEnv()) {
    return null
  }
  // Why: memoized so terminal spawns never re-stat the shim on the hot path.
  if (cachedShimPath === undefined) {
    const candidates = [
      join(dirname(process.execPath), SHIM_EXECUTABLE),
      resolve(__dirname, '../../native/tcc-disclaim-macos/.build/release', SHIM_EXECUTABLE)
    ]
    cachedShimPath = candidates.find((candidate) => existsSync(candidate)) ?? null
  }
  return cachedShimPath
}

export function resetMacosTccDisclaimShimForTests(): void {
  cachedShimPath = undefined
}
