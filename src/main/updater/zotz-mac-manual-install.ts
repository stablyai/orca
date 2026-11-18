import { ZOTZ_RELEASES_URL } from '../../shared/zotz/zotz-app-identity'

declare global {
  // Global so upstream updater suites that reset modules keep testing Squirrel.Mac installs.
  var zotzMacSelfUpdateForTests: boolean | undefined
}

export function _setZotzMacSelfUpdateForTests(enabled: boolean): void {
  globalThis.zotzMacSelfUpdateForTests = enabled
}

// Unknown until the probe answers, which counts as manual: offering the dmg is always safe.
let runningAppHasStableIdentity = false

/**
 * Squirrel.Mac only installs a build that meets the running app's designated requirement.
 * Ad-hoc builds pin it to their own cdhash; a certificate (even self-signed) pins it to the
 * certificate, which every release shares (docs/zotz/UPDATES-SPEC.md §6).
 */
export function hasStableMacSigningIdentity(
  codesignDisplay: string,
  exitCode: number | null
): boolean {
  return (
    exitCode === 0 &&
    /^Authority=/m.test(codesignDisplay) &&
    !/^Signature=adhoc$/m.test(codesignDisplay)
  )
}

/** Reads the running app's signature once, before the first update check can finish. */
export async function probeZotzMacSigningIdentity(): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    // Loaded here, not at module scope: this file sits on the updater's import path, and an
    // eager import replaces the process host that other suites mock.
    const { runProcess } = await import('@orca/process-host')
    const result = await runProcess({
      program: '/usr/bin/codesign',
      args: ['-dvv', process.execPath],
      timeoutMs: 5_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // codesign writes its display fields to stderr.
    runningAppHasStableIdentity =
      !result.timedOut &&
      hasStableMacSigningIdentity(`${result.stderr}\n${result.stdout}`, result.code)
  } catch {
    runningAppHasStableIdentity = false
  }
}

export function isZotzManualMacInstall(): boolean {
  return (
    process.platform === 'darwin' &&
    globalThis.zotzMacSelfUpdateForTests !== true &&
    !runningAppHasStableIdentity
  )
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
