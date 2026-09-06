#!/usr/bin/env node

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { startCdpServer } from 'inspect-webkit'
import { resolveEmulatorOrcaCli } from './emulator-orca-cli-selection.mjs'
import { stopHostedChildProcess } from './hosted-child-process-shutdown.mjs'
import { findAvailableHostedLoopbackPort } from './hosted-loopback-port.mjs'
import { probeHostedIosAppBoundNavigation } from './hosted-ios-app-bound-navigation-probe.mjs'
import { startHostedIosEmulatorController } from './hosted-ios-emulator-controller.mjs'
import { openHostedIosHybridRoute } from './hosted-ios-hybrid-route-handoff.mjs'
import {
  startHostedIosMobileLauncher,
  waitForHostedIosMobileLauncher
} from './hosted-ios-mobile-launcher.mjs'
import { completeHostedIosNativeOnboarding } from './hosted-ios-native-onboarding.mjs'
import { hostedIosSimulatorAppPreparation } from './hosted-ios-simulator-app-preparation.mjs'
import {
  bootHostedIosSimulator,
  resolveHostedIosSimulatorUdid
} from './hosted-ios-simulator-device.mjs'
import {
  activateHostedWebViewControl,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { resolveHostedWebViewRuntimeDirectory } from './hosted-webview-runtime-directory.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

const worktree = path.resolve(import.meta.dirname, '../..')
const options = parseOptions(process.argv.slice(2))
const runtimeDirectory = resolveHostedWebViewRuntimeDirectory({
  worktree,
  override: process.env.ORCA_E2E_MOBILE_WEBVIEW_RUN_DIRECTORY
})
const orcaSelection = resolveEmulatorOrcaCli({
  explicitCommand: process.env.ORCA_CLI,
  managedCommand: process.env.ORCA_CLI_COMMAND,
  devRepoRoot: process.env.ORCA_DEV_REPO_ROOT,
  worktree,
  cwd: worktree
})

function parseOptions(args) {
  const parsed = {
    device: 'iPhone 17 Pro',
    reuseNativeInstall: false,
    skipNativeBuild: false,
    timeoutMs: 180_000
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--device' && args[index + 1]) {
      parsed.device = args[++index]
    } else if (args[index] === '--timeout-ms' && args[index + 1]) {
      parsed.timeoutMs = Number(args[++index])
    } else if (args[index] === '--skip-native-build') {
      parsed.skipNativeBuild = true
    } else if (args[index] === '--reuse-native-install') {
      parsed.reuseNativeInstall = true
    } else {
      throw new Error(`Unknown argument: ${args[index]}`)
    }
  }
  return parsed
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('The hosted iOS app-bound navigation probe requires macOS and Xcode.')
  }
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  const deviceUdid = await resolveHostedIosSimulatorUdid(options.device)
  let launcher = null
  let inspector = null
  let emulatorController = null
  try {
    await bootHostedIosSimulator(deviceUdid)
    emulatorController = await startHostedIosEmulatorController({
      orcaCli: orcaSelection.command,
      runtimeDirectory,
      worktree
    })
    const appPreparation = hostedIosSimulatorAppPreparation({ deviceUdid, worktree, ...options })
    const nativeAppPath = await appPreparation.run()
    launcher = startHostedIosMobileLauncher({
      deviceUdid,
      emulatorControlUserDataPath: emulatorController.userData,
      orcaCli: orcaSelection.command,
      runtimeDirectory,
      worktree
    })
    await waitForHostedIosMobileLauncher(launcher, options.timeoutMs)
    const emulator = {
      deviceUdid,
      orcaCli: orcaSelection.command,
      userDataDir: emulatorController.userData,
      worktree
    }
    const inspectorPort = await findAvailableHostedLoopbackPort()
    const discoveryUrl = `http://127.0.0.1:${inspectorPort}`
    inspector = await startCdpServer({ port: inspectorPort })
    const expectedWorkspace = path.basename(worktree)
    await completeHostedIosNativeOnboarding(emulator, expectedWorkspace, options.timeoutMs)
    await openHostedIosHybridRoute(emulator, options.timeoutMs)
    const workspaceDocument = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: expectedWorkspace,
      timeoutMs: options.timeoutMs
    })
    await activateHostedWorkspaceRow(
      workspaceDocument,
      expectedWorkspace,
      activateHostedWebViewControl,
      options.timeoutMs,
      () =>
        waitForVisibleHostedWebView({
          discoveryUrl,
          expectedText: expectedWorkspace,
          timeoutMs: options.timeoutMs
        })
    )
    const sessionDocument = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: 'Mobile Emulator',
      expectedHrefIncludes: '/session/',
      timeoutMs: options.timeoutMs
    })
    const appBound = await probeHostedIosAppBoundNavigation({
      deviceUdid,
      emulator,
      sessionDocument,
      timeoutMs: options.timeoutMs
    })
    console.log(JSON.stringify({ appBound, nativeAppPath }, null, 2))
  } finally {
    inspector?.stop()
    await stopHostedChildProcess(launcher)
    await emulatorController?.stop()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
