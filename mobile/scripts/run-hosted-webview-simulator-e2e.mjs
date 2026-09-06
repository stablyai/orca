#!/usr/bin/env node

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { startCdpServer } from 'inspect-webkit'
import { resolveEmulatorOrcaCli } from './emulator-orca-cli-selection.mjs'
import {
  createHostedAdversarialRuntimeFixture,
  removeHostedAdversarialRuntimeFixture
} from './hosted-adversarial-runtime-fixture.mjs'
import {
  verifyHostedAdversarialProviderReview,
  verifyHostedAdversarialTasks
} from './hosted-adversarial-provider-content.mjs'
import { stopHostedChildProcess } from './hosted-child-process-shutdown.mjs'
import { findAvailableHostedLoopbackPort } from './hosted-loopback-port.mjs'
import { parseHostedWebViewSimulatorE2eOptions } from './hosted-webview-simulator-e2e-options.mjs'
import {
  captureHostedAccountsParity,
  captureNativeAccountsBaseline
} from './hosted-ios-accounts-parity.mjs'
import { startHostedIosEmulatorController } from './hosted-ios-emulator-controller.mjs'
import { createHostedIosNativeBaselineStep } from './hosted-ios-native-baseline-step.mjs'
import {
  assertNoHostedMobileWebCdpTarget,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { verifyHostedWebViewPrivacyIsolation } from './hosted-webview-privacy-isolation.mjs'
import { captureNativeAgentHistoryBaseline } from './hosted-ios-agent-history-parity.mjs'
import {
  createHostedIosAdversarialContentInspector,
  registerHostedIosAdversarialRepository
} from './hosted-ios-adversarial-content.mjs'
import { enableHostedTerminalDiagnostics } from './hosted-adversarial-terminal-links.mjs'
import {
  captureHostedCoreRouteParity,
  captureNativeCoreRouteBaselines
} from './hosted-ios-core-route-parity.mjs'
import {
  captureHostedFilesPreviewParity,
  captureNativeFilesPreviewBaselines
} from './hosted-ios-files-preview-parity.mjs'
import {
  captureHostedWorkspaceParity,
  captureNativeWorkspaceBaseline
} from './hosted-ios-workspace-parity.mjs'
import { verifyHostedAgentHistoryJourney } from './hosted-ios-agent-history-journey.mjs'
import {
  alignHostedIosSessionPoint,
  verifyHostedIosAdversarialTerminalLinks
} from './hosted-ios-adversarial-terminal-links.mjs'
import {
  tapHostedIosAccessibilityControlByLabelPrefix,
  tapHostedIosPoint
} from './hosted-ios-emulator-accessibility.mjs'
import { openHostedIosHybridRoute } from './hosted-ios-hybrid-route-handoff.mjs'
import {
  startHostedIosMobileLauncher,
  waitForHostedIosMobileLauncher
} from './hosted-ios-mobile-launcher.mjs'
import { verifyHostedIosNativeSettingsJourney } from './hosted-ios-native-settings-journey.mjs'
import { verifyHostedIosNativeAlertJourney } from './hosted-ios-native-alert-journey.mjs'
import {
  bootHostedIosSimulator,
  resolveHostedIosSimulatorUdid
} from './hosted-ios-simulator-device.mjs'
import { verifyHostedSourceControlReviewJourney } from './hosted-ios-source-control-review-journey.mjs'
import { verifyHostedHostOriginSourceControlJourney } from './hosted-ios-host-origin-source-control-journey.mjs'
import { captureNativeSourceControlReviewBaselines } from './hosted-ios-source-control-review-parity.mjs'
import { resetHostedIosPhotosPermission } from './hosted-ios-photo-permission-denial.mjs'
import { verifyHostedIosTerminalInputJourney } from './hosted-ios-terminal-device-input-journey.mjs'
import { waitForHostedIosBuildActivation } from './hosted-ios-build-activation.mjs'
import { completeHostedIosNativeOnboarding } from './hosted-ios-native-onboarding.mjs'
import { resolveHostedWebViewRuntimeDirectory } from './hosted-webview-runtime-directory.mjs'
import {
  clearHostedIosWebViewSecurityProbe,
  configureHostedIosWebViewSecurityProbe,
  startHostedIosWebViewSecurityProbe
} from './hosted-ios-webview-security-probe.mjs'
import { hostedIosSimulatorAppPreparation } from './hosted-ios-simulator-app-preparation.mjs'
import {
  installHostedWebViewRouteExceptionCapture,
  readHostedWebViewRouteExceptionEvidence
} from './hosted-webview-route-exception-evidence.mjs'
import { captureHostedWebViewSecurityEvidence } from './hosted-webview-security-evidence.mjs'
import { evidenceStep, printHostedWebViewE2eReport } from './hosted-webview-e2e-report.mjs'

const worktree = path.resolve(import.meta.dirname, '../..')
const options = parseHostedWebViewSimulatorE2eOptions(process.argv.slice(2))
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

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Hosted iOS WebView automation requires macOS and Xcode.')
  }
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  const deviceUdid = await resolveHostedIosSimulatorUdid(options.device)
  let launcher = null
  let inspector = null
  let networkProbe = null
  let emulatorController = null
  let nativeAppPath = null
  let adversarialFixture = null
  let adversarialInspector = null
  let adversarialProviderContent = null
  let adversarialSessionYOffset = 0
  let adversarialTerminalLinks = null
  let adversarialTerminalHandle = null
  let hostedExceptionDocument = null
  try {
    networkProbe = await startHostedIosWebViewSecurityProbe()
    if (options.adversarialContent) {
      adversarialFixture = await createHostedAdversarialRuntimeFixture({
        probePort: networkProbe.port
      })
    }
    await bootHostedIosSimulator(deviceUdid)
    emulatorController = await startHostedIosEmulatorController({
      orcaCli: orcaSelection.command,
      runtimeDirectory,
      worktree
    })
    await configureHostedIosWebViewSecurityProbe(deviceUdid, networkProbe)
    const appPreparation = hostedIosSimulatorAppPreparation({ deviceUdid, worktree, ...options })
    nativeAppPath = await evidenceStep(appPreparation.label, appPreparation.run)
    if (options.securityOnly) {
      await evidenceStep('Photos permission reset', () =>
        resetHostedIosPhotosPermission(deviceUdid)
      )
    }
    launcher = startHostedIosMobileLauncher({
      deviceUdid,
      emulatorControlUserDataPath: emulatorController.userData,
      environment: adversarialFixture?.environment,
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
    const nativeBaselineStep = createHostedIosNativeBaselineStep({
      assertNoHostedMobileWebCdpTarget,
      discoveryUrl,
      evidenceStep
    })
    const expectedWorkspace = path.basename(worktree)
    const nativeOnboarding = await evidenceStep('native onboarding', () =>
      completeHostedIosNativeOnboarding(emulator, expectedWorkspace, options.timeoutMs)
    )
    if (adversarialFixture) {
      adversarialTerminalHandle = await evidenceStep('adversarial repository registration', () =>
        registerHostedIosAdversarialRepository({
          fixture: adversarialFixture,
          orcaCli: orcaSelection.command,
          pairingRuntimeUserDataPath: path.join(runtimeDirectory, 'paired-host', 'userData'),
          probe: networkProbe,
          timeoutMs: options.timeoutMs
        })
      )
      adversarialInspector = createHostedIosAdversarialContentInspector({
        emulator,
        fixture: adversarialFixture,
        timeoutMs: options.timeoutMs
      })
    }
    const nativeWorkspace =
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await nativeBaselineStep('native workspace baseline', () =>
            captureNativeWorkspaceBaseline({
              deviceUdid,
              emulator,
              runtimeDirectory,
              timeoutMs: options.timeoutMs
            })
          )
    const nativeAccounts =
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await nativeBaselineStep('native Accounts baseline', () =>
            captureNativeAccountsBaseline({
              deviceUdid,
              emulator,
              expectedWorkspace,
              runtimeDirectory,
              timeoutMs: options.timeoutMs
            })
          )
    const nativeCoreRoutes =
      options.accountsOnly ||
      options.adversarialContent ||
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await nativeBaselineStep('native Tasks and Session baselines', () =>
            captureNativeCoreRouteBaselines({
              deviceUdid,
              emulator,
              expectedWorkspace,
              runtimeDirectory,
              timeoutMs: options.timeoutMs
            })
          )
    const nativeFilesPreview =
      options.accountsOnly ||
      options.securityOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await nativeBaselineStep('native Files and Preview baselines', () =>
            captureNativeFilesPreviewBaselines({
              deviceUdid,
              emulator,
              expectedWorkspace,
              runtimeDirectory,
              timeoutMs: options.timeoutMs
            })
          )
    const nativeSourceControlReview =
      options.accountsOnly ||
      options.adversarialContent ||
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly
        ? null
        : await nativeBaselineStep('native Source Control and Review baselines', () =>
            captureNativeSourceControlReviewBaselines({
              deviceUdid,
              emulator,
              expectedWorkspace,
              runtimeDirectory,
              timeoutMs: options.timeoutMs
            })
          )
    const nativeAgentHistory =
      options.accountsOnly ||
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await nativeBaselineStep('native Agent History baseline', () =>
            captureNativeAgentHistoryBaseline({
              deviceUdid,
              emulator,
              expectedWorkspace,
              runtimeDirectory,
              timeoutMs: options.timeoutMs
            })
          )
    await evidenceStep('native hybrid route handoff', () =>
      openHostedIosHybridRoute(emulator, options.timeoutMs)
    )
    let workspaceDocument = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: expectedWorkspace,
      timeoutMs: options.timeoutMs
    })
    hostedExceptionDocument = workspaceDocument
    await installHostedWebViewRouteExceptionCapture(workspaceDocument)
    const nativeAlert = await evidenceStep('native Alert bridge journey', () =>
      verifyHostedIosNativeAlertJourney({
        discoveryUrl,
        emulator,
        expectedWorkspace,
        timeoutMs: options.timeoutMs,
        workspaceDocument
      })
    )
    workspaceDocument = nativeAlert.workspaceDocument
    if (adversarialFixture) {
      await enableHostedTerminalDiagnostics(workspaceDocument)
    }
    const workspacePrivacyIsolation = options.adversarialContent
      ? await evidenceStep('workspace privacy isolation probe', () =>
          verifyHostedWebViewPrivacyIsolation({ document: workspaceDocument })
        )
      : null
    if (adversarialFixture) {
      const result = await evidenceStep('adversarial task and error presentation', () =>
        verifyHostedAdversarialTasks({
          activatePoint: (point) => tapHostedIosPoint(emulator, point),
          discoveryUrl,
          document: workspaceDocument,
          timeoutMs: options.timeoutMs
        })
      )
      adversarialProviderContent = { tasks: result.evidence, review: null }
      workspaceDocument = result.workspaceDocument
    }
    const securityJourney = {
      deviceUdid,
      discoveryUrl,
      emulator,
      orcaCli: orcaSelection.command,
      pairingRuntimeUserDataPath: path.join(runtimeDirectory, 'paired-host', 'userData'),
      timeoutMs: options.timeoutMs,
      worktree
    }
    const terminalDeviceInput =
      options.securityOnly && !options.isolationOnly
        ? await evidenceStep('hosted terminal device input journey', () =>
            verifyHostedIosTerminalInputJourney(
              { ...securityJourney, expectedWorkspace, workspaceDocument },
              options
            )
          )
        : null
    const hostedWorkspace =
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await evidenceStep('hosted workspace parity', () =>
            captureHostedWorkspaceParity({
              deviceUdid,
              document: workspaceDocument,
              nativeBaseline: nativeWorkspace,
              runtimeDirectory,
              timeoutMs: options.timeoutMs
            })
          )
    const hostedAccounts =
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await evidenceStep('hosted Accounts parity', () =>
            captureHostedAccountsParity({
              deviceUdid,
              discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
              emulator,
              nativeBaseline: nativeAccounts,
              runtimeDirectory,
              timeoutMs: options.timeoutMs,
              expectedWorkspace,
              workspaceDocument
            })
          )
    workspaceDocument = hostedAccounts?.workspaceDocument ?? workspaceDocument
    const hostedCoreRoutes =
      options.accountsOnly ||
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await evidenceStep('hosted Tasks and Session parity', () =>
            captureHostedCoreRouteParity({
              deviceUdid,
              discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
              emulator,
              expectedWorkspace,
              nativeBaselines: nativeCoreRoutes,
              runtimeDirectory,
              timeoutMs: options.timeoutMs,
              workspaceDocument
            })
          )
    const activeWorkspaceDocument = hostedCoreRoutes?.workspaceDocument ?? workspaceDocument
    const hostedFilesPreview =
      options.accountsOnly ||
      options.securityOnly ||
      options.nativeSettingsOnly ||
      options.sourceControlOnly
        ? null
        : await evidenceStep('hosted Files and Preview parity', () =>
            captureHostedFilesPreviewParity({
              deviceUdid,
              discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
              emulator,
              expectedWorkspace,
              nativeBaselines: nativeFilesPreview,
              runtimeDirectory,
              timeoutMs: options.timeoutMs,
              workspaceDocument: activeWorkspaceDocument
            })
          )
    const parityWorkspaceDocument = hostedFilesPreview?.workspaceDocument ?? activeWorkspaceDocument
    const historyEvidence =
      options.accountsOnly ||
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.sourceControlOnly
        ? null
        : options.nativeSettingsOnly
          ? await evidenceStep('native Terminal Settings journey', () =>
              verifyHostedIosNativeSettingsJourney({
                discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
                emulator,
                workspaceDocument: parityWorkspaceDocument,
                expectedWorkspace,
                timeoutMs: options.timeoutMs
              })
            )
          : await evidenceStep('Agent History journey', () =>
              verifyHostedAgentHistoryJourney({
                discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
                launcher,
                emulator,
                nativeAgentHistory,
                runtimeDirectory,
                workspaceDocument: parityWorkspaceDocument,
                expectedWorkspace,
                timeoutMs: options.timeoutMs
              })
            )
    const sourceControlReview =
      options.accountsOnly ||
      options.securityOnly ||
      options.filesPreviewOnly ||
      options.nativeSettingsOnly
        ? null
        : await evidenceStep('Source Control and Review journey', async () => {
            let hostOrigin
            if (options.sourceControlOnly) {
              hostOrigin = await evidenceStep('host-origin Source Control journey', () =>
                verifyHostedHostOriginSourceControlJourney({
                  discoveryUrl,
                  emulator,
                  nativeBaseline: nativeSourceControlReview.sourceControl,
                  timeoutMs: options.timeoutMs,
                  workspaceName: expectedWorkspace
                })
              )
              workspaceDocument = hostOrigin.workspaceDocument
              await tapHostedIosAccessibilityControlByLabelPrefix(
                emulator,
                adversarialFixture?.workspaceRowName ?? expectedWorkspace,
                options.timeoutMs
              )
            }
            let sessionDocument = await waitForVisibleHostedWebView({
              discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
              expectedText: options.sourceControlOnly ? '1 tab' : '2 tabs',
              expectedHrefIncludes: '/session/',
              requireInteractiveControls: false,
              timeoutMs: options.timeoutMs
            })
            if (adversarialInspector) {
              const result = await evidenceStep('adversarial terminal links', () =>
                verifyHostedIosAdversarialTerminalLinks({
                  ...securityJourney,
                  deviceUdid,
                  document: sessionDocument,
                  emulator,
                  positiveFilePath: adversarialFixture.repositoryFiles[0].filename,
                  probe: networkProbe,
                  stagedTerminalHandle: adversarialTerminalHandle,
                  worktree: adversarialFixture.root
                })
              )
              adversarialTerminalLinks = result.evidence
              adversarialSessionYOffset = result.yOffset
              sessionDocument = result.sessionDocument
            }
            const sessionOrigin = await verifyHostedSourceControlReviewJourney({
              deviceUdid,
              discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
              emulator,
              expectedSessionDiffText: adversarialInspector
                ? '3 tabs'
                : options.sourceControlOnly
                  ? '2 tabs'
                  : '3 tabs',
              nativeBaselines: nativeSourceControlReview,
              nativeReviewOpen: nativeSourceControlReview?.sessionOriginReviewOpen ?? null,
              inspectChangedContent: adversarialInspector?.inspect,
              inspectProviderContent: adversarialProviderContent
                ? async ({ document }) => {
                    adversarialProviderContent.review = await verifyHostedAdversarialProviderReview(
                      {
                        document,
                        timeoutMs: options.timeoutMs
                      }
                    )
                  }
                : undefined,
              runtimeDirectory,
              sessionDocument,
              transformPoint: adversarialInspector
                ? (point, document) =>
                    alignHostedIosSessionPoint(point, adversarialSessionYOffset, document)
                : undefined,
              timeoutMs: options.timeoutMs
            })
            return { ...sessionOrigin, ...(hostOrigin ? { hostOrigin } : {}) }
          })
    const adversarialContent = adversarialInspector
      ? await evidenceStep('adversarial filename and diff presentation', () =>
          adversarialInspector.evidence()
        )
      : null
    const securityDocument =
      options.securityOnly && terminalDeviceInput
        ? (terminalDeviceInput.terminalClipboardImagePaste?.sessionDocument ??
          terminalDeviceInput.photoPermissionRevocation?.sessionDocument ??
          terminalDeviceInput.terminalClipboardPaste.sessionDocument)
        : options.accountsOnly || options.filesPreviewOnly || options.isolationOnly
          ? parityWorkspaceDocument
          : await waitForVisibleHostedWebView({
              discoveryUrl: `http://127.0.0.1:${inspectorPort}`,
              expectedText: options.nativeSettingsOnly ? 'Mobile Emulator' : 'reviewed',
              expectedHrefIncludes: options.nativeSettingsOnly ? '/session/' : '/review/',
              timeoutMs: options.timeoutMs
            })
    const { executableIsolation, navigationIsolation, networkIsolation, privacyIsolation } =
      await captureHostedWebViewSecurityEvidence({
        document: securityDocument,
        evidenceStep,
        probeId: networkProbe.token,
        workspacePrivacyIsolation
      })
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (networkProbe.observations.length > 0) {
      throw new Error(
        `Hosted WebView reached the network probe: ${networkProbe.observations.join(', ')}`
      )
    }
    await waitForHostedIosBuildActivation(deviceUdid, options, runtimeDirectory)
    printHostedWebViewE2eReport({
      adversarialContent,
      adversarialProviderContent,
      adversarialTerminalLinks,
      deviceUdid,
      executableIsolation,
      expectedWorkspace,
      historyEvidence,
      hostedAccounts,
      hostedCoreRoutes,
      hostedFilesPreview,
      hostedWorkspace,
      nativeAlert,
      nativeAppPath,
      nativeOnboarding,
      navigationIsolation,
      networkIsolation,
      privacyIsolation,
      sourceControlReview,
      terminalDeviceInput,
      workspaceDocument
    })
  } catch (error) {
    const evidence = hostedExceptionDocument
      ? await readHostedWebViewRouteExceptionEvidence(hostedExceptionDocument).catch(() => [])
      : []
    if (evidence.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Hosted exception evidence: ${JSON.stringify(evidence)}`,
        { cause: error }
      )
    }
    throw error
  } finally {
    inspector?.stop()
    await stopHostedChildProcess(launcher)
    if (adversarialFixture) {
      await removeHostedAdversarialRuntimeFixture(adversarialFixture)
    }
    await emulatorController?.stop()
    await clearHostedIosWebViewSecurityProbe(deviceUdid)
    await networkProbe?.stop()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
