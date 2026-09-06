#!/usr/bin/env node

import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { resolveEmulatorOrcaCli } from './emulator-orca-cli-selection.mjs'
import { verifyHostedAndroidAdversarialTerminalLinks } from './hosted-android-adversarial-terminal-links.mjs'
import { stageHostedAdversarialTerminalLinks } from './hosted-adversarial-terminal-links.mjs'
import { verifyHostedAndroidAgentHistoryJourney } from './hosted-android-agent-history-journey.mjs'
import { HOSTED_ADVERSARIAL_CONTENT_MARKER } from './hosted-adversarial-repository-fixture.mjs'
import {
  createHostedAdversarialRuntimeFixture,
  removeHostedAdversarialRuntimeFixture
} from './hosted-adversarial-runtime-fixture.mjs'
import {
  verifyHostedAdversarialProviderReview,
  verifyHostedAdversarialTasks
} from './hosted-adversarial-provider-content.mjs'
import {
  readHostedAndroidExitInfo,
  verifyHostedAndroidPrivacyAudit
} from './hosted-android-privacy-audit.mjs'
import {
  tapHostedAndroidAccessibilityControl,
  tapHostedAndroidPoint
} from './hosted-android-emulator-accessibility.mjs'
import {
  activateHostedAndroidWorkspaceControl,
  prepareHostedAndroidWorkspaceInput
} from './hosted-android-workspace-activation.mjs'
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
import { runAndroidAdb } from './hosted-android-mobile-web-cache.mjs'
import { pairHostedAndroidApp } from './hosted-android-pairing.mjs'
import { HOSTED_MOBILE_APP_ROUTE_URL } from './hosted-mobile-e2e-launch.mjs'
import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  readHostedWebViewTextPoint,
  verifyHostedWebViewNavigationIsolation,
  verifyHostedWebViewNetworkIsolation,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { verifyHostedWebViewExecutableIsolation } from './hosted-webview-executable-isolation.mjs'
import { verifyHostedWebViewPrivacyIsolation } from './hosted-webview-privacy-isolation.mjs'
import {
  captureHostedWebViewAdversarialObservation,
  hostedWebViewAdversarialContentObservations
} from './hosted-webview-adversarial-content.mjs'
import { inspectHostedWebViewAdversarialFiles } from './hosted-webview-adversarial-files.mjs'
import { resolveHostedWebViewRuntimeDirectory } from './hosted-webview-runtime-directory.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'
import { verifyHostedSourceControlReviewJourney } from './hosted-ios-source-control-review-journey.mjs'
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
  let exitInfoBaseline
  let adversarialFixture
  const reversePorts = new Set()
  try {
    await stage('Android emulator', () => runAndroidAdb(adb, ['get-state']))
    await stage('Android log reset', () => runAndroidAdb(adb, ['logcat', '-c']))
    exitInfoBaseline = await stage('Android exit-info baseline', () =>
      readHostedAndroidExitInfo(adb)
    )
    if (!options.skipNativeBuild) {
      await stage('Android debug app build', () => buildHostedAndroidDebugApp({ adb, androidDir }))
    }
    probe = await stage('network isolation sentinel', startHostedWebViewSecurityProbe)
    if (options.adversarialContent) {
      adversarialFixture = await stage('adversarial repository fixture', () =>
        createHostedAdversarialRuntimeFixture({ probePort: probe.port })
      )
    }
    runtime = await stage('temporary paired desktop runtime', () =>
      startHeadlessPairingRuntime({
        enabled: true,
        orcaCli,
        cwd: worktree,
        environment: adversarialFixture?.environment,
        runDirectory: path.join(runtimeDirectory, 'paired-host'),
        lanIpCandidates: () => ['127.0.0.1'],
        logStep: () => {},
        logSuccess: () => {}
      })
    )
    if (!options.adversarialContent) {
      runtime.env.ORCA_E2E_MOBILE_AGENT_HISTORY_FIXTURE = '1'
    }
    const testWorkspace = adversarialFixture?.root ?? worktree
    if (adversarialFixture) {
      await stage('provider error workspace registration', () =>
        registerWorktreeForPairingRuntime(runtime, worktree, {
          orca: runOrca,
          logStep: () => {},
          logSuccess: () => {}
        })
      )
    }
    await stage('test workspace registration', () =>
      registerWorktreeForPairingRuntime(runtime, testWorkspace, {
        orca: runOrca,
        logStep: () => {},
        logSuccess: () => {}
      })
    )
    const adversarialTerminalHandle = adversarialFixture
      ? await stage('adversarial terminal fixture', () =>
          stageHostedAdversarialTerminalLinks({
            orcaCli,
            pairingRuntimeUserDataPath: runtime.userData,
            positiveFilePath: adversarialFixture.repositoryFiles[0].filename,
            probePort: probe.port,
            probeToken: probe.token,
            timeoutMs: options.timeoutMs,
            worktree: testWorkspace
          })
        )
      : null
    metro = await stage('Metro', () =>
      startHostedAndroidMetro({ mobileDir, pairingUrl: runtime.pairingUrl })
    )
    for (const port of [runtime.port, metro.port, probe.port]) {
      await runAndroidAdb(adb, ['reverse', `tcp:${port}`, `tcp:${port}`])
      reversePorts.add(port)
    }
    await stage('sentinel reachability red check', () => proveSentinelReachability(adb, probe))
    await stage('exact Android app install', () =>
      installAndResetHostedAndroidApp(adb, options.apk)
    )
    await stage('development client launch', () =>
      launchHostedAndroidDevClient(adb, metro.port, probe)
    )
    await stage('React runtime', () => waitForHostedAndroidReactReady(adb, options.timeoutMs))
    const emulator = { adb }
    await stage('native pairing', () =>
      pairHostedAndroidApp({ adb, pairingUrl: runtime.pairingUrl, timeoutMs: options.timeoutMs })
    )
    await stage('native hybrid route handoff', async () => {
      await openHostedAndroidUrl(adb, HOSTED_MOBILE_APP_ROUTE_URL)
    })
    inspector = await stage('Android WebView inspector', () =>
      forwardHostedAndroidInspector(adb, options.timeoutMs)
    )
    const discoveryUrl = `http://127.0.0.1:${inspector.port}`
    await stage('hosted workspace route', () =>
      waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: 'Host 1',
        timeoutMs: options.timeoutMs
      })
    )
    const expectedWorkspace = path.basename(testWorkspace)
    const workspaceRowName = adversarialFixture?.workspaceRowName ?? expectedWorkspace
    let workspaceDocument = await stage('hosted workspace data', () =>
      waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: expectedWorkspace.toLocaleUpperCase(),
        timeoutMs: options.timeoutMs
      })
    )
    const privacyIsolation = await stage('workspace privacy isolation probe', () =>
      verifyHostedWebViewPrivacyIsolation({ document: workspaceDocument })
    )
    let adversarialProviderContent = null
    if (adversarialFixture) {
      const result = await stage('adversarial task and error presentation', () =>
        verifyHostedAdversarialTasks({
          activatePoint: (point) => tapHostedAndroidPoint(emulator, point),
          discoveryUrl,
          document: workspaceDocument,
          timeoutMs: options.timeoutMs
        })
      )
      adversarialProviderContent = { tasks: result.evidence, review: null }
      workspaceDocument = result.workspaceDocument
    }
    const sessionDocument = await stage(
      'workspace activation and hosted Session route',
      async () => {
        await prepareHostedAndroidWorkspaceInput(emulator)
        let activeDocument = workspaceDocument
        let lastError
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!activeDocument.href.includes('/session/')) {
            await activateHostedWorkspaceRow(
              activeDocument,
              workspaceRowName,
              (document, target) =>
                activateHostedAndroidWorkspaceControl(emulator, document, target),
              Math.min(options.timeoutMs, 15_000),
              () =>
                waitForVisibleHostedWebView({
                  discoveryUrl,
                  expectedText: workspaceRowName,
                  timeoutMs: options.timeoutMs
                })
            )
          }
          try {
            return await waitForVisibleHostedWebView({
              discoveryUrl,
              expectedText: '1 tab',
              expectedHrefIncludes: '/session/',
              requireInteractiveControls: false,
              timeoutMs: Math.min(options.timeoutMs, 15_000)
            })
          } catch (error) {
            lastError = error
            activeDocument = await waitForVisibleHostedWebView({
              discoveryUrl,
              expectedText: 'Host 1',
              timeoutMs: options.timeoutMs
            })
          }
        }
        const state = await readHostedWebViewState(activeDocument)
        throw new Error(
          `${lastError instanceof Error ? lastError.message : String(lastError)}. Diagnostics labels=${JSON.stringify(
            state.labels
          )} bodyText=${JSON.stringify(state.bodyText)}`
        )
      }
    )
    let agentHistory = null
    let adversarialContent = null
    let adversarialTerminalLinks = null
    let adversarialReviewDocument = null
    const adversarialObservations = []
    let sourceControlReview = null
    let isolationDocument = sessionDocument
    if (!options.securityOnly) {
      let sourceSessionDocument = sessionDocument
      if (options.adversarialContent) {
        const result = await stage('adversarial terminal links', () =>
          verifyHostedAndroidAdversarialTerminalLinks({
            discoveryUrl,
            document: sourceSessionDocument,
            emulator,
            orcaCli,
            pairingRuntimeUserDataPath: runtime.userData,
            positiveFilePath: adversarialFixture.repositoryFiles[0].filename,
            probe,
            tapPoint: tapHostedAndroidPoint,
            terminalHandle: adversarialTerminalHandle,
            timeoutMs: options.timeoutMs,
            worktree: testWorkspace
          })
        )
        adversarialTerminalLinks = result.evidence
        sourceSessionDocument = result.sessionDocument
      }
      if (!options.adversarialContent) {
        const agentHistoryResult = await stage('Agent History journey', () =>
          verifyHostedAndroidAgentHistoryJourney({
            discoveryUrl,
            emulator,
            sessionDocument,
            timeoutMs: options.timeoutMs
          })
        )
        const { returnedSessionDocument, ...evidence } = agentHistoryResult
        agentHistory = evidence
        sourceSessionDocument = returnedSessionDocument
      }
      sourceControlReview = await stage('Source Control and Review journey', () =>
        verifyHostedSourceControlReviewJourney({
          discoveryUrl,
          emulator,
          sessionDocument: sourceSessionDocument,
          expectedSessionDiffText: '3 tabs',
          inspectChangedContent: options.adversarialContent
            ? async ({ document, phase }) => {
                if (phase === 'sessionDiff') {
                  await activateAndroidAdversarialDiffTab(
                    emulator,
                    document,
                    adversarialFixture.filename
                  )
                }
                adversarialObservations.push(
                  await captureHostedWebViewAdversarialObservation({
                    document,
                    expectedMarker:
                      phase === 'sessionDiff' ? HOSTED_ADVERSARIAL_CONTENT_MARKER : undefined,
                    timeoutMs: Math.min(options.timeoutMs, 15_000)
                  })
                )
                if (phase === 'review') {
                  adversarialReviewDocument = document
                }
              }
            : undefined,
          inspectProviderContent: adversarialProviderContent
            ? async ({ document }) => {
                adversarialProviderContent.review = await verifyHostedAdversarialProviderReview({
                  document,
                  timeoutMs: options.timeoutMs
                })
              }
            : undefined,
          timeoutMs: options.timeoutMs,
          tapPoint: tapHostedAndroidJourneyControl
        })
      )
      if (options.adversarialContent) {
        adversarialContent = await stage('adversarial filename and diff presentation', async () => {
          try {
            return await inspectAndroidAdversarialContent({
              document: adversarialReviewDocument,
              fixture: adversarialFixture,
              observations: adversarialObservations,
              timeoutMs: options.timeoutMs
            })
          } catch (error) {
            const states = adversarialObservations.map(({ state }) => ({
              bodyText: state.bodyText.slice(0, 1024),
              labels: state.labels.slice(0, 16)
            }))
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}. States ${JSON.stringify(states)}`
            )
          }
        })
      }
      isolationDocument = await waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: 'reviewed',
        expectedHrefIncludes: '/review/',
        timeoutMs: options.timeoutMs
      })
    }
    const networkIsolation = await stage('network isolation probe', () =>
      verifyHostedWebViewNetworkIsolation({
        document: isolationDocument,
        probeId: probe.token
      })
    )
    const navigationIsolation = await stage('navigation isolation probe', () =>
      verifyHostedWebViewNavigationIsolation({
        document: isolationDocument,
        discoveryUrl,
        probeId: probe.token
      })
    )
    const executableIsolation = await stage('executable isolation probe', () =>
      verifyHostedWebViewExecutableIsolation({
        document: isolationDocument,
        probeId: probe.token
      })
    )
    await delay(500)
    if (probe.observations.length > 0) {
      throw new Error(
        `Hosted Android WebView reached the sentinel: ${probe.observations.join(', ')}`
      )
    }
    await stage('Android bridge log audit', () => assertHostedAndroidBridgeLogClean(adb))
    const privacyAudit = await stage('Android privacy and exit-info audit', () =>
      verifyHostedAndroidPrivacyAudit({
        adb,
        baselineExitInfo: exitInfoBaseline,
        devServerPort: metro.port,
        probePort: probe.port
      })
    )
    console.log(
      JSON.stringify(
        {
          ok: true,
          device: await runAndroidAdb(adb, ['shell', 'getprop', 'ro.product.model']),
          pid: inspector.pid,
          workspace: expectedWorkspace,
          agentHistory,
          adversarialContent,
          adversarialProviderContent,
          adversarialTerminalLinks,
          sourceControlReview,
          networkIsolation,
          navigationIsolation,
          executableIsolation,
          privacyIsolation,
          privacyAudit,
          sentinelObservations: probe.observations
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
    if (adversarialFixture) {
      await removeHostedAdversarialRuntimeFixture(adversarialFixture)
    }
  }
}

async function inspectAndroidAdversarialContent({ document, fixture, observations, timeoutMs }) {
  if (!document) {
    throw new Error('Hosted Android adversarial Review document is unavailable')
  }
  return {
    ...hostedWebViewAdversarialContentObservations(observations),
    ...(await inspectHostedWebViewAdversarialFiles({
      document,
      fixture,
      timeoutMs
    }))
  }
}

async function tapHostedAndroidJourneyControl(emulator, point, label, attempt = 0, document) {
  if (label && attempt === 0) {
    try {
      return await tapHostedAndroidAccessibilityControl(emulator, label, 5_000)
    } catch {
      // Chromium may omit a WebView descendant during an accessibility-tree refresh.
    }
  }
  if (label && attempt > 0 && document) {
    return activateHostedWebViewControl(document, { kind: 'label', value: label, reveal: true })
  }
  return tapHostedAndroidPoint(emulator, point)
}

async function activateAndroidAdversarialDiffTab(emulator, document, filename) {
  const point = await readHostedWebViewTextPoint(document, filename, undefined, {
    horizontalPosition: 0.15
  })
  await tapHostedAndroidPoint(emulator, point)
  await delay(250)
}

async function proveSentinelReachability(command, probe) {
  await runAndroidAdb(command, ['shell', 'nc', '-z', '-w', '5', '127.0.0.1', String(probe.port)])
  if (!probe.observations.includes('tcp:connection')) {
    throw new Error('Android loopback sentinel red check did not arrive')
  }
  probe.reset()
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
  process.stderr.write(`[android-e2e] ${label}...\n`)
  try {
    const result = await run()
    process.stderr.write(`[android-e2e] ${label}: ok\n`)
    return result
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
}

function parseOptions(args) {
  const result = {
    adb: null,
    apk: defaultApk,
    adversarialContent: false,
    securityOnly: false,
    skipNativeBuild: false,
    timeoutMs: 90_000
  }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--') {
      continue
    } else if (option === '--adb') {
      result.adb = requireValue(args, ++index, option)
    } else if (option === '--apk') {
      result.apk = path.resolve(requireValue(args, ++index, option))
    } else if (option === '--adversarial-content') {
      result.adversarialContent = true
    } else if (option === '--skip-native-build') {
      result.skipNativeBuild = true
    } else if (option === '--security-only') {
      result.securityOnly = true
    } else if (option === '--timeout-ms') {
      result.timeoutMs = Number.parseInt(requireValue(args, ++index, option), 10)
    } else {
      throw new Error(`Unknown option: ${option}`)
    }
  }
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000')
  }
  if (result.adversarialContent && result.securityOnly) {
    throw new Error('--adversarial-content and --security-only are mutually exclusive')
  }
  return result
}

function requireValue(args, index, option) {
  if (!args[index]) {
    throw new Error(`${option} requires a value`)
  }
  return args[index]
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
