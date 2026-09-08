import {
  activateHostedWebViewControl,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import {
  restartHostedIosEmulatorController,
  tapHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControl
} from './hosted-ios-emulator-accessibility.mjs'

export async function verifyHostedNativeTerminalSettingsHandoff({
  discoveryUrl,
  emulator,
  sessionDocument,
  timeoutMs,
  expectedSessionText = '2 tabs'
}) {
  await activateHostedWebViewControl(sessionDocument, {
    kind: 'label',
    value: 'Add custom shortcut',
    reveal: true
  })
  const shortcutDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: 'Manage Shortcuts',
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  await restartHostedIosEmulatorController(emulator)
  const nativeTapPoint = await tapHostedIosAccessibilityControl(
    emulator,
    'Manage Shortcuts',
    timeoutMs
  )
  await waitForHostedIosAccessibilityControl(emulator, 'WHEN YOU LEAVE THE APP', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Back to hosted session', timeoutMs)
  const returnedDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: expectedSessionText,
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  if (returnedDocument.href !== shortcutDocument.href) {
    throw new Error('Native Terminal Settings did not return to the same hosted session route')
  }
  return {
    route: returnedDocument.href,
    nativeTapPoint
  }
}
