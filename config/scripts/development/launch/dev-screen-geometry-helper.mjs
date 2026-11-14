import { buildSwiftCliHelper } from '../../native-build/macos/swift-cli-helper-macos.mjs'

/**
 * NSScreen's notch geometry has no Electron API, so without this helper every MacBook renders the
 * notch as a centred capsule in dev and the hardware-notch path is never exercised.
 */
export function buildDevScreenGeometryHelper() {
  try {
    // No --output: unpackaged builds resolve the helper from the repo's .build/release
    // (see resolveHelperPath in src/main/notch/screen-geometry.ts), not from the bundle.
    buildSwiftCliHelper({
      nativeDir: 'screen-geometry-macos',
      executable: 'orca-screen-geometry',
      argv: ['--single-arch']
    })
  } catch (error) {
    console.warn(
      `[orca-dev] screen-geometry helper build failed (notch falls back to the pill): ${error?.message ?? error}`
    )
  }
}
