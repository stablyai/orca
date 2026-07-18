import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { track } from '../telemetry/client'

/**
 * Invariants: `tooLarge: true` implies `found: true`; `data` is present iff
 * `found && !tooLarge`. The native side returns not-found only for a
 * genuinely-absent rev/path; operational failures (repo open, rev resolution,
 * object read) REJECT so the caller can fall back to the git CLI. Callers must
 * therefore catch rejections rather than assuming a resolved result.
 */
export type NativeBlobResult = {
  found: boolean
  tooLarge: boolean
  data?: Buffer
}

export type GitNativeModule = {
  nativeGitPing(): number
  /**
   * maxBytes must be a non-negative integer <= 0xFFFFFFFF (native u32;
   * out-of-range values wrap silently). Callers pass MAX_GIT_SHOW_BYTES.
   */
  readBlobAtRevPath(
    repoPath: string,
    rev: string,
    path: string,
    maxBytes: number
  ): Promise<NativeBlobResult>
  readBlobAtIndexPath(repoPath: string, path: string, maxBytes: number): Promise<NativeBlobResult>
}

// Why: mirrors resolveWslHookRelayBundle / getSherpaModulePath — packaged
// Resources first, then the dev build output; ORCA_GIT_NATIVE_PATH overrides
// for tests and benches.
function resolveGitNativeModulePath(): string | null {
  const override = process.env.ORCA_GIT_NATIVE_PATH
  if (override) {
    return existsSync(override) ? override : null
  }
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'git-native', 'git-native.node')
    if (existsSync(packaged)) {
      return packaged
    }
  }
  const dev = path.join(process.cwd(), 'native', 'git-native', '.build', 'git-native.node')
  return existsSync(dev) ? dev : null
}

// Outer null = load never attempted; inner `module: null` = attempted, unavailable.
let cached: { module: GitNativeModule | null } | null = null

export function loadGitNativeModule(): GitNativeModule | null {
  if (cached) {
    return cached.module
  }
  cached = { module: null }
  const modulePath = resolveGitNativeModulePath()
  if (!modulePath) {
    return cached.module
  }
  let failureClass: 'load_error' | 'ping_mismatch' | null = null
  try {
    // Why: the main bundle is CJS and vite-node provides __filename in tests,
    // so this one form works in both contexts (import.meta needs no shim).
    const requireNative = createRequire(__filename)
    const module = requireNative(modulePath) as GitNativeModule
    if (module.nativeGitPing() === 1) {
      cached.module = module
    } else {
      failureClass = 'ping_mismatch'
    }
  } catch {
    // Why: a ping that throws deliberately classifies as load_error — the
    // addon's dispatch is broken, so "load" is the honest class.
    failureClass = 'load_error'
  }
  if (failureClass !== null) {
    // Why: a broken addon must degrade silently to the CLI path for the user;
    // one low-cardinality event makes fleet-wide breakage observable. The
    // track call is guarded so a throwing track() (posthog / validate /
    // getSettings have no internal guard) can neither double-emit nor escape
    // loadGitNativeModule — an escape would abort the read instead of returning
    // null for CLI fallback.
    try {
      track('git_native_load_failed', { error_class: failureClass })
    } catch {
      // Native addon failures must always degrade to the CLI path.
    }
  }
  return cached.module
}

export function resetGitNativeModuleForTests(): void {
  cached = null
}
