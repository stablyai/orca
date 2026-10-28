import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * NSScreen's notch geometry has no Electron API, so without this helper every MacBook renders the
 * notch as a centred capsule in dev and the hardware-notch path is never exercised.
 */
export function buildDevScreenGeometryHelper(repoRoot) {
  try {
    execFileSync(
      process.execPath,
      // No --output: unpackaged builds resolve the helper from the repo's .build/release
      // (see resolveHelperPath in src/main/notch/screen-geometry.ts), not from the bundle.
      [
        path.join(repoRoot, 'config', 'scripts', 'build-screen-geometry-macos.mjs'),
        '--single-arch'
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.warn(
      `[orca-dev] screen-geometry helper build failed (notch falls back to the pill): ${error?.message ?? error}`
    )
  }
}
