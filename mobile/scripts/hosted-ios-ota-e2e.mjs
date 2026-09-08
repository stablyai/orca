import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { startCdpServer } from 'inspect-webkit'
import { createHostedIosOtaPackageFixture } from './hosted-ios-ota-package-fixture.mjs'
import { fingerprintHostedIosOtaShell } from './hosted-ios-ota-shell-fingerprint.mjs'
import { verifyHostedIosOtaJourney } from './hosted-ios-ota-journey.mjs'
import { stopHostedChildProcess } from './hosted-child-process-shutdown.mjs'
import { findAvailableHostedLoopbackPort } from './hosted-loopback-port.mjs'
import { startHostedIosEmulatorController } from './hosted-ios-emulator-controller.mjs'
import {
  startHostedIosMobileLauncher,
  waitForHostedIosMobileLauncher
} from './hosted-ios-mobile-launcher.mjs'
import {
  bootHostedIosSimulator,
  resolveHostedIosSimulatorUdid
} from './hosted-ios-simulator-device.mjs'
import { hostedIosSimulatorAppPreparation } from './hosted-ios-simulator-app-preparation.mjs'
import { completeHostedIosNativeOnboarding } from './hosted-ios-native-onboarding.mjs'
import { openHostedIosHybridRoute } from './hosted-ios-hybrid-route-handoff.mjs'
import { evidenceStep } from './hosted-webview-e2e-report.mjs'

const execFileAsync = promisify(execFile)

export async function runHostedIosOtaE2e({ options, runtimeDirectory, orcaCli, worktree }) {
  if (process.platform !== 'darwin') {
    throw new Error('Hosted iOS OTA automation requires macOS')
  }
  if (!options.reuseNativeInstall) {
    throw new Error('Ordinary OTA proof requires --reuse-native-install')
  }
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  const fixture = await createHostedIosOtaPackageFixture({
    sourceRoot:
      process.env.ORCA_MOBILE_WEB_PACKAGE_ROOT ?? path.join(worktree, 'out', 'mobile-web-rnw'),
    runtimeDirectory
  })
  if (options.expectedBuild && options.expectedBuild !== fixture.sourceBuildId) {
    throw new Error('OTA fixture source does not match --expected-build')
  }
  const deviceUdid = await resolveHostedIosSimulatorUdid(options.device)
  let launcher
  let inspector
  let controller
  try {
    await bootHostedIosSimulator(deviceUdid)
    controller = await startHostedIosEmulatorController({ orcaCli, runtimeDirectory, worktree })
    const preparation = hostedIosSimulatorAppPreparation({ deviceUdid, worktree, ...options })
    await evidenceStep(preparation.label, preparation.run)
    const container = async (kind) =>
      (
        await execFileAsync('xcrun', [
          'simctl',
          'get_app_container',
          deviceUdid,
          'com.stably.orca.mobile',
          kind
        ])
      ).stdout.trim()
    const nativeAppPath = await container('app')
    const appDataPath = await container('data')
    const fingerprintArgs = { worktree, nativeAppPath }
    const before = await fingerprintHostedIosOtaShell(fingerprintArgs)
    launcher = startHostedIosMobileLauncher({
      deviceUdid,
      emulatorControlUserDataPath: controller.userData,
      environment: { ORCA_MOBILE_WEB_PACKAGE_ROOT: fixture.servedPackagePath },
      orcaCli,
      runtimeDirectory,
      worktree
    })
    await waitForHostedIosMobileLauncher(launcher, options.timeoutMs)
    const emulator = { deviceUdid, orcaCli, userDataDir: controller.userData, worktree }
    const expectedWorkspace = path.basename(worktree)
    await evidenceStep('native onboarding', () =>
      completeHostedIosNativeOnboarding(emulator, expectedWorkspace, options.timeoutMs)
    )
    const inspectorPort = await findAvailableHostedLoopbackPort()
    inspector = await startCdpServer({ port: inspectorPort })
    await openHostedIosHybridRoute(emulator, options.timeoutMs)
    const ota = await evidenceStep('frozen-shell ordinary OTA A to B', () =>
      verifyHostedIosOtaJourney({
        deviceUdid,
        discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
        expectedWorkspace,
        fixture,
        launcher,
        runtimeDirectory,
        timeoutMs: options.timeoutMs,
        appDataPath
      })
    )
    const after = await fingerprintHostedIosOtaShell(fingerprintArgs)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Native artifact or shell source changed during OTA proof')
    }
    console.log(
      JSON.stringify(
        { ok: true, device: deviceUdid, nativeAppPath, frozenShell: { before, after }, ota },
        null,
        2
      )
    )
  } finally {
    inspector?.stop()
    await stopHostedChildProcess(launcher)
    await controller?.stop()
  }
}
