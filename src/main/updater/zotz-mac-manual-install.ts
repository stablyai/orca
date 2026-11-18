import { ZOTZ_RELEASES_URL } from '../../shared/zotz/zotz-app-identity'

declare global {
  // Global so upstream updater suites that reset modules keep testing Squirrel.Mac installs.
  var zotzMacSelfUpdateForTests: boolean | undefined
}

export function _setZotzMacSelfUpdateForTests(enabled: boolean): void {
  globalThis.zotzMacSelfUpdateForTests = enabled
}

// Ad-hoc signed builds pin Squirrel.Mac to their own cdhash, so it rejects every new build
// (docs/zotz/UPDATES-SPEC.md §6). Return false once releases carry a Developer ID signature.
export function isZotzManualMacInstall(): boolean {
  return process.platform === 'darwin' && globalThis.zotzMacSelfUpdateForTests !== true
}

/** Offers the release's dmg instead of a download the host could never install. */
export function zotzManualMacInstallFields(
  version: string
): { externallyManaged: true; zotzManualDownloadUrl: string } | null {
  if (!isZotzManualMacInstall()) {
    return null
  }
  // Human-named copy the release workflow uploads (zotz-desktop-builds.yml).
  return {
    externallyManaged: true,
    zotzManualDownloadUrl: `${ZOTZ_RELEASES_URL}/download/v${version}/zotz-macos-arm64.dmg`
  }
}
