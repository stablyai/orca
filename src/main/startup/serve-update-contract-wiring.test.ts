import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `launchServeMode` has no unit-testable seam — it pulls the whole main-process graph — so the
 * ordering the update contract depends on is asserted against the source, matching
 * serve-desktop-activation-wiring.test.ts.
 */
describe('serve update contract wiring', () => {
  const runtimeSource = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
    'utf8'
  )
  const serveLaunchIndex = runtimeSource.indexOf('async function launchServeMode(')
  const desktopLaunchIndex = runtimeSource.indexOf('async function launchDesktopMode(')

  it('records the serve install mode before any client can read status', () => {
    const installModeIndex = runtimeSource.indexOf(
      'setUpdateInstallMode(serveInstallMode)',
      serveLaunchIndex
    )
    const rpcStartIndex = runtimeSource.indexOf('await runtimeRpc.start()', serveLaunchIndex)

    expect(serveLaunchIndex).toBeGreaterThanOrEqual(0)
    expect(installModeIndex).toBeGreaterThan(serveLaunchIndex)
    expect(installModeIndex).toBeLessThan(rpcStartIndex)
    expect(installModeIndex).toBeLessThan(desktopLaunchIndex)
  })

  it('starts the release check after readiness so stdout stays the readiness API', () => {
    const readinessIndex = runtimeSource.indexOf('await printServeReady(serveOptions)')
    const reportIndex = runtimeSource.indexOf(
      'startServeManualUpdateReporting({ installMode: serveInstallMode })',
      serveLaunchIndex
    )

    expect(readinessIndex).toBeGreaterThan(serveLaunchIndex)
    expect(reportIndex).toBeGreaterThan(readinessIndex)
    expect(reportIndex).toBeLessThan(desktopLaunchIndex)
  })

  // Why: the reporter is only consulted inside the unsupported-headless-serve status branch, so an
  // ungated start would fetch the release feed and log update advice on a supervised host whose own
  // status surface never carries it.
  it('pays for the release check only on the mode that publishes the contract', () => {
    expect(runtimeSource).toContain('const serveInstallMode = resolveUpdateInstallMode(true)')
    expect(runtimeSource).not.toContain('startServeManualUpdateReporting()')
  })

  it('never gives serve an install or restart path', () => {
    const serveBody = runtimeSource.slice(serveLaunchIndex, desktopLaunchIndex)

    for (const forbidden of ['quitAndInstall', 'downloadRemoteServerUpdate', 'sudo', 'systemctl']) {
      expect(serveBody).not.toContain(forbidden)
    }
  })
})
