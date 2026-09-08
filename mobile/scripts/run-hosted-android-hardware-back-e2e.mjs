#!/usr/bin/env node

import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { resolveEmulatorOrcaCli } from './emulator-orca-cli-selection.mjs'
import {
  assertHostedAndroidBridgeLogClean,
  buildHostedAndroidDebugApp,
  forwardHostedAndroidInspector,
  installAndResetHostedAndroidApp,
  launchHostedAndroidDevClient,
  openHostedAndroidUrl,
  resolveHostedAndroidAdb,
  startHostedAndroidMetro,
  stopHostedAndroidApp,
  waitForHostedAndroidReactReady
} from './hosted-android-emulator-session.mjs'
import { verifyHostedAndroidHardwareBackJourney } from './hosted-android-hardware-back-journey.mjs'
import { runAndroidAdb } from './hosted-android-mobile-web-cache.mjs'
import { pairHostedAndroidApp } from './hosted-android-pairing.mjs'
import {
  activateHostedAndroidWorkspaceControl,
  prepareHostedAndroidWorkspaceInput
} from './hosted-android-workspace-activation.mjs'
import { HOSTED_MOBILE_APP_ROUTE_URL } from './hosted-mobile-e2e-launch.mjs'
import { waitForVisibleHostedWebView } from './hosted-webview-cdp-session.mjs'
import { resolveHostedWebViewRuntimeDirectory } from './hosted-webview-runtime-directory.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'
import { startHostedWebViewSecurityProbe } from './hosted-ios-webview-security-probe.mjs'
import {
  registerWorktreeForPairingRuntime,
  startHeadlessPairingRuntime
} from './start-emulator-pairing-runtime.mjs'

const execFileAsync = promisify(execFile)
const worktree = path.resolve(import.meta.dirname, '../..')
const mobileDir = path.join(worktree, 'mobile')
const androidDir = path.join(mobileDir, 'android')
const defaultApk = path.join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk')
const options = parseOptions(process.argv.slice(2))
const adb = resolveHostedAndroidAdb(options.adb)
const runtimeDirectory = resolveHostedWebViewRuntimeDirectory({
  worktree,
  override: process.env.ORCA_E2E_MOBILE_WEBVIEW_RUN_DIRECTORY
})
const orcaCli = resolveEmulatorOrcaCli({
  explicitCommand: process.env.ORCA_CLI,
  managedCommand: process.env.ORCA_CLI_COMMAND,
  devRepoRoot: process.env.ORCA_DEV_REPO_ROOT,
  worktree,
  cwd: worktree
}).command

async function main() {
  let runtime
  let metro
  let probe
  let inspector
  const reversePorts = new Set()
  try {
    await stage('Android emulator', () => runAndroidAdb(adb, ['get-state']))
    await stage('Android log reset', () => runAndroidAdb(adb, ['logcat', '-c']))
    if (!options.skipNativeBuild) {
      await stage('Android debug app build', () => buildHostedAndroidDebugApp({ adb, androidDir }))
    }
    probe = await stage('network isolation sentinel', startHostedWebViewSecurityProbe)
    runtime = await stage('temporary paired desktop runtime', () =>
      startHeadlessPairingRuntime({
        enabled: true,
        orcaCli,
        cwd: worktree,
        runDirectory: path.join(runtimeDirectory, 'paired-host'),
        lanIpCandidates: () => ['127.0.0.1'],
        logStep: () => {},
        logSuccess: () => {}
      })
    )
    await stage('test workspace registration', () =>
      registerWorktreeForPairingRuntime(runtime, worktree, {
        orca: runOrca,
        logStep: () => {},
        logSuccess: () => {}
      })
    )
    metro = await stage('Metro', () =>
      startHostedAndroidMetro({ mobileDir, pairingUrl: runtime.pairingUrl })
    )
    for (const port of [runtime.port, metro.port, probe.port]) {
      await runAndroidAdb(adb, ['reverse', `tcp:${port}`, `tcp:${port}`])
      reversePorts.add(port)
    }
    await stage('exact Android app install', () =>
      installAndResetHostedAndroidApp(adb, options.apk)
    )
    await stage('development client launch', () =>
      launchHostedAndroidDevClient(adb, metro.port, probe)
    )
    await stage('React runtime', () => waitForHostedAndroidReactReady(adb, options.timeoutMs))
    await stage('native pairing', () =>
      pairHostedAndroidApp({ adb, pairingUrl: runtime.pairingUrl, timeoutMs: options.timeoutMs })
    )
    await stage('native hybrid route handoff', () =>
      openHostedAndroidUrl(adb, HOSTED_MOBILE_APP_ROUTE_URL)
    )
    inspector = await stage('Android WebView inspector', () =>
      forwardHostedAndroidInspector(adb, options.timeoutMs)
    )
    const discoveryUrl = `http://127.0.0.1:${inspector.port}`
    const workspaceName = path.basename(worktree)
    let workspaceDocument = await stage('hosted workspace data', () =>
      waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: workspaceName.toLocaleUpperCase(),
        timeoutMs: options.timeoutMs
      })
    )
    const sessionDocument = await stage('hosted Session route', async () => {
      await prepareHostedAndroidWorkspaceInput({ adb })
      await activateHostedWorkspaceRow(
        workspaceDocument,
        workspaceName,
        (document, target) => activateHostedAndroidWorkspaceControl({ adb }, document, target),
        options.timeoutMs,
        async () => {
          workspaceDocument = await waitForVisibleHostedWebView({
            discoveryUrl,
            expectedText: workspaceName.toLocaleUpperCase(),
            timeoutMs: options.timeoutMs
          })
          return workspaceDocument
        }
      )
      return waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: '1 tab',
        expectedHrefIncludes: '/session/',
        requireInteractiveControls: false,
        timeoutMs: options.timeoutMs
      })
    })
    const evidence = await stage('real Android hardware Back journey', () =>
      verifyHostedAndroidHardwareBackJourney({
        adb,
        discoveryUrl,
        emulator: { adb },
        sessionDocument,
        timeoutMs: options.timeoutMs,
        workspaceMarker: workspaceName.toLocaleUpperCase()
      })
    )
    await stage('Android bridge log audit', () => assertHostedAndroidBridgeLogClean(adb))
    console.log(
      JSON.stringify(
        {
          ok: true,
          device: await runAndroidAdb(adb, ['shell', 'getprop', 'ro.product.model']),
          workspace: workspaceName,
          ...evidence
        },
        null,
        2
      )
    )
  } finally {
    await stopHostedAndroidApp(adb)
    if (inspector) {
      await runAndroidAdb(adb, ['forward', '--remove', `tcp:${inspector.port}`]).catch(() => {})
    }
    for (const port of reversePorts) {
      await runAndroidAdb(adb, ['reverse', '--remove', `tcp:${port}`]).catch(() => {})
    }
    await metro?.stop()
    await runtime?.stop({ shutdownDaemon: true })
    await probe?.stop()
  }
}

async function runOrca(args, runOptions) {
  const result = await execFileAsync(orcaCli, args, {
    cwd: runOptions.cwd,
    env: runOptions.env,
    encoding: 'utf8',
    timeout: runOptions.timeout
  })
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

async function stage(label, run) {
  process.stderr.write(`[android-back-e2e] ${label}...\n`)
  try {
    const result = await run()
    process.stderr.write(`[android-back-e2e] ${label}: ok\n`)
    return result
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
}

function parseOptions(args) {
  const result = { adb: null, apk: defaultApk, skipNativeBuild: false, timeoutMs: 90_000 }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--') {
      continue
    }
    if (option === '--adb') {
      result.adb = requireValue(args, ++index, option)
    } else if (option === '--apk') {
      result.apk = path.resolve(requireValue(args, ++index, option))
    } else if (option === '--skip-native-build') {
      result.skipNativeBuild = true
    } else if (option === '--timeout-ms') {
      result.timeoutMs = Number.parseInt(requireValue(args, ++index, option), 10)
    } else {
      throw new Error(`Unknown option: ${option}`)
    }
  }
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000')
  }
  return result
}

function requireValue(args, index, option) {
  if (!args[index]) {
    throw new Error(`${option} requires a value`)
  }
  return args[index]
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
