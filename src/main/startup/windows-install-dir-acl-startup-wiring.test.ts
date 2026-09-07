import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The three call sites that make the repair real. Each is one line of wiring in a
 * module whose import graph makes it untestable in-process; the behaviour each
 * line depends on is driven for real in `windows-install-dir-acl-recovery.test.ts`,
 * `gpu-lifecycle-install-dir-acl-guard.test.ts` and `focus-existing-window.test.ts`.
 */

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('install-dir ACL repair startup wiring', () => {
  // The entire premise: a renderer must never be spawned onto a tree a previous
  // launch recorded as poisoned before icacls has had its bounded chance at it.
  it('awaits the pre-window gate before any window creation', () => {
    const source = readSource('src/main/startup/main-process-runtime-launch.ts')
    const launchStart = source.indexOf('export async function initializeMainProcessRuntimeLaunch(')
    expect(launchStart).toBeGreaterThanOrEqual(0)
    const launch = source.slice(launchStart)

    const gateIndex = launch.indexOf('await repairKnownPoisonedInstallDirBeforeWindow(')
    const winEarlyWindowIndex = launch.indexOf('startWindowsDesktopBeforeShellPathReady(')
    const desktopLaunchIndex = launch.indexOf('await launchDesktopMode(')
    expect(gateIndex).toBeGreaterThanOrEqual(0)
    expect(winEarlyWindowIndex).toBeGreaterThan(gateIndex)
    expect(desktopLaunchIndex).toBeGreaterThan(gateIndex)
  })

  // A 20s blank launch invites a second double-click, and `focusExistingMainWindow`
  // opens a window whenever there is none and the app is ready.
  it('holds the second-instance reopen while the gate owns the launch', () => {
    const source = readSource('src/main/startup/main-window-actions.ts')
    const start = source.indexOf('export function focusExistingWindow(')
    const end = source.indexOf('\nexport function showMainWindowFromTray(', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).toContain(
      'canOpenWindow: () => !isBlockingInstallDirAclRepairInFlight()'
    )
  })

  // openMainWindow re-runs on every reopen while the probe is once-per-process, so
  // arming the grace window unconditionally would drop GPU crashes on a healthy machine.
  it('arms the probe grace window only for a dispatched probe', () => {
    const source = readSource('src/main/startup/main-window-controller.ts')
    const dispatchIndex = source.indexOf('const probeDispatched = probeWindowsInstallDirAcl(')
    const armIndex = source.indexOf('noteWindowsInstallDirAclProbePending()')
    expect(dispatchIndex).toBeGreaterThanOrEqual(0)
    expect(armIndex).toBeGreaterThan(dispatchIndex)
    expect(source.slice(dispatchIndex, armIndex)).toContain('if (probeDispatched) {')
  })
})
