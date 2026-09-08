import { longPressHostedIosPoint } from './hosted-ios-emulator-long-press.mjs'
import { readHostedWebViewControlPoint } from './hosted-webview-control-point.mjs'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'
import { verifyHostedSessionActions } from './hosted-webview-session-actions-journey.mjs'
import {
  readHostedChatPreference,
  waitHostedChatPreference,
  waitHostedChatPreferenceReady
} from './hosted-ios-chat-settings-journey.mjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { startCdpServer } from 'inspect-webkit'
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
import {
  createHostedChatRuntimeFixture,
  HOSTED_CHAT_TERMINAL_TITLE
} from './hosted-chat-runtime-fixture.mjs'
import { verifyHostedChatJourney } from './hosted-webview-chat-journey.mjs'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { openHostedIosSettings, closeHostedIosSettings } from './hosted-ios-settings-navigation.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'
import { waitForHostedIosBuildActivation } from './hosted-ios-build-activation.mjs'

export async function runHostedIosChatE2e({ options, runtimeDirectory, orcaCli, worktree }) {
  if (process.platform !== 'darwin') {
    throw new Error('Hosted iOS chat requires macOS')
  }
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  const deviceUdid = await resolveHostedIosSimulatorUdid(options.device)
  let launcher, inspector, controller, fixture, observedDocument
  try {
    await bootHostedIosSimulator(deviceUdid)
    controller = await startHostedIosEmulatorController({ orcaCli, runtimeDirectory, worktree })
    const preparation = hostedIosSimulatorAppPreparation({ deviceUdid, worktree, ...options })
    const nativeAppPath = await preparation.run()
    launcher = startHostedIosMobileLauncher({
      deviceUdid,
      emulatorControlUserDataPath: controller.userData,
      orcaCli,
      runtimeDirectory,
      worktree
    })
    await waitForHostedIosMobileLauncher(launcher, options.timeoutMs)
    const emulator = { deviceUdid, orcaCli, userDataDir: controller.userData, worktree }
    const expectedWorkspace = path.basename(worktree)
    await completeHostedIosNativeOnboarding(emulator, expectedWorkspace, options.timeoutMs)
    fixture = await createHostedChatRuntimeFixture({
      orcaCli,
      runtimeDirectory,
      worktree,
      timeoutMs: options.timeoutMs
    })
    const inspectorPort = await findAvailableHostedLoopbackPort()
    inspector = await startCdpServer({ port: inspectorPort })
    const discoveryUrl = `http://127.0.0.1:${inspectorPort}`
    await openHostedIosHybridRoute(emulator, options.timeoutMs)
    const args = { discoveryUrl, timeoutMs: options.timeoutMs, expectedWorkspace }
    let workspace = await waitForVisibleHostedWebView({ ...args, expectedText: expectedWorkspace })
    observedDocument = workspace
    await evaluateHostedDocumentWithRetry(
      workspace,
      `(() => {
      const entries = globalThis.__orcaChatBridgeErrors = [];
      addEventListener('message', event => {
        try {
          const frame = JSON.parse(event.data);
          if (frame.status === 'error' || frame.type === 'subscriptionClosed') {
            entries.push({ type: frame.type, code: frame.error?.code, requestId: frame.requestId });
            if (entries.length > 32) entries.shift();
          }
        } catch {}
      });
      return 'observing';
    })()`
    )
    const settings = await openHostedIosSettings(
      args,
      workspace,
      'Chat UI',
      '/native-chat-settings',
      'for this paired host'
    )
    await waitHostedChatPreferenceReady(settings, options.timeoutMs)
    const originalPreference = await readHostedChatPreference(settings)
    if (!originalPreference) {
      await activateHostedWebViewControl(settings, {
        kind: 'label',
        value: 'Open sessions in Chat UI'
      })
      await waitHostedChatPreference(settings, true, options.timeoutMs)
    }
    workspace = await closeHostedIosSettings(args, settings)
    await activateHostedWorkspaceRow(
      workspace,
      expectedWorkspace,
      activateHostedWebViewControl,
      options.timeoutMs,
      () => waitForVisibleHostedWebView({ ...args, expectedText: expectedWorkspace })
    )
    const session = await waitForVisibleHostedWebView({
      ...args,
      expectedHrefIncludes: '/session/',
      expectedText: HOSTED_CHAT_TERMINAL_TITLE
    })
    await activateHostedWebViewControl(session, { kind: 'text', value: HOSTED_CHAT_TERMINAL_TITLE })
    const chat = await verifyHostedChatJourney({
      discoveryUrl,
      timeoutMs: options.timeoutMs,
      ...fixture
    }).catch(async (error) => {
      console.error(
        'Chat bridge errors:',
        await evaluateHostedDocumentWithRetry(
          session,
          'JSON.stringify(globalThis.__orcaChatBridgeErrors ?? [])'
        )
      )
      throw error
    })
    const screenshot = path.join(runtimeDirectory, 'hosted-chat-transcript.png')
    await captureScreenshot(deviceUdid, screenshot)
    const sessionActions = await verifyHostedSessionActions({
      discoveryUrl,
      timeoutMs: options.timeoutMs,
      document: chat.document,
      originalTitle: HOSTED_CHAT_TERMINAL_TITLE,
      readTerminals: fixture.readTerminals,
      longPress: async (document, title) =>
        longPressHostedIosPoint(
          emulator,
          await readHostedWebViewControlPoint(document, title, undefined, { matchText: true })
        )
    })
    await activateHostedWebViewControl(sessionActions.document, {
      kind: 'label',
      value: 'Back to worktrees'
    })
    workspace = await waitForVisibleHostedWebView({ ...args, expectedText: expectedWorkspace })
    const restored = await openHostedIosSettings(
      args,
      workspace,
      'Chat UI',
      '/native-chat-settings',
      'for this paired host'
    )
    await waitHostedChatPreferenceReady(restored, options.timeoutMs)
    if (!originalPreference) {
      await activateHostedWebViewControl(restored, {
        kind: 'label',
        value: 'Open sessions in Chat UI'
      })
    }
    await waitHostedChatPreference(restored, originalPreference, options.timeoutMs)
    await waitForHostedIosBuildActivation(deviceUdid, options, runtimeDirectory)
    const bridgeErrors = JSON.parse(
      await evaluateHostedDocumentWithRetry(
        observedDocument,
        'JSON.stringify(globalThis.__orcaChatBridgeErrors ?? [])'
      )
    )
    if (bridgeErrors.some((entry) => entry.code === 'rate_limited')) {
      throw new Error('Ordinary chat/session journey exceeded bridge admission')
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          device: deviceUdid,
          nativeAppPath,
          chat: { ...chat.evidence, screenshot },
          sessionActions: sessionActions.evidence,
          fixtureTerminal: fixture.handle,
          bridgeErrors
        },
        null,
        2
      )
    )
  } catch (error) {
    if (observedDocument) {
      console.error(
        'Chat failure page:',
        JSON.stringify(await readHostedWebViewState(observedDocument))
      )
      console.error(
        'Chat bridge errors:',
        await evaluateHostedDocumentWithRetry(
          observedDocument,
          'JSON.stringify(globalThis.__orcaChatBridgeErrors ?? [])'
        )
      )
      await captureScreenshot(deviceUdid, path.join(runtimeDirectory, 'hosted-chat-failure.png'))
    }
    throw error
  } finally {
    try {
      await fixture?.cleanup()
    } finally {
      inspector?.stop()
      try {
        await stopHostedChildProcess(launcher)
      } finally {
        await controller?.stop()
      }
    }
  }
}
