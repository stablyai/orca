import {
  activateHostedWebViewControl,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { verifyHostedNativeTerminalSettingsHandoff } from './hosted-ios-native-settings-handoff.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

export async function verifyHostedIosNativeSettingsJourney({
  discoveryUrl,
  emulator,
  workspaceDocument,
  expectedWorkspace,
  timeoutMs
}) {
  await activateHostedWorkspaceRow(
    workspaceDocument,
    expectedWorkspace,
    activateHostedWebViewControl,
    timeoutMs,
    () =>
      waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: expectedWorkspace,
        timeoutMs
      })
  )
  const sessionDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: 'Mobile Emulator',
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  return verifyHostedNativeTerminalSettingsHandoff({
    discoveryUrl,
    emulator,
    sessionDocument,
    timeoutMs,
    expectedSessionText: 'Mobile Emulator'
  })
}
