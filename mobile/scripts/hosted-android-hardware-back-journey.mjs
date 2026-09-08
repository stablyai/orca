import { waitForHostedAndroidAccessibilityControlMatch } from './hosted-android-emulator-accessibility.mjs'
import { runAndroidAdb } from './hosted-android-mobile-web-cache.mjs'
import {
  activateHostedWebViewControl,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'

export async function sendHostedAndroidHardwareBack(adb, runAdb = runAndroidAdb) {
  await runAdb(adb, ['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
}

export async function verifyHostedAndroidHardwareBackJourney(
  { adb, discoveryUrl, emulator, sessionDocument, timeoutMs, workspaceMarker },
  dependencies = {}
) {
  const openAgentHistory = dependencies.openAgentHistory ?? openHostedAndroidHardwareBackNestedRoute
  const pressBack = dependencies.pressBack ?? sendHostedAndroidHardwareBack
  const waitForDocument = dependencies.waitForDocument ?? waitForVisibleHostedWebView
  const waitForWorkspaceRoot =
    dependencies.waitForWorkspaceRoot ?? waitForHostedAndroidWorkspaceRoot
  const waitForNativeControl =
    dependencies.waitForNativeControl ?? waitForHostedAndroidAccessibilityControlMatch

  const historyDocument = await openAgentHistory({
    discoveryUrl,
    emulator,
    sessionDocument,
    timeoutMs
  })
  await pressBack(adb)
  const returnedSession = await waitForDocument({
    discoveryUrl,
    expectedText: '1 tab',
    expectedHrefIncludes: '/session/',
    requireInteractiveControls: false,
    timeoutMs
  })
  await pressBack(adb)
  const workspaceRoot = await waitForWorkspaceRoot({
    discoveryUrl,
    timeoutMs,
    waitForDocument,
    workspaceMarker
  })
  if (workspaceRoot.href.includes('/session/') || workspaceRoot.href.includes('/agent-history/')) {
    throw new Error(`Android hardware Back did not reach the workspace root: ${workspaceRoot.href}`)
  }
  await pressBack(adb)
  const nativeShell = await waitForNativeControl(
    emulator,
    [
      'Open settings',
      'Open sessions in Chat UI',
      'Open sessions in the terminal',
      'Show paired hosts'
    ],
    timeoutMs
  )

  return {
    nestedRoute: historyDocument.href,
    returnedSessionRoute: returnedSession.href,
    workspaceRootRoute: workspaceRoot.href,
    nativeShellControl: nativeShell.label,
    hardwareBackPresses: 3
  }
}

export async function waitForHostedAndroidWorkspaceRoot({
  discoveryUrl,
  settle = delay,
  timeoutMs,
  waitForDocument = waitForVisibleHostedWebView,
  workspaceMarker
}) {
  const deadline = Date.now() + timeoutMs
  let lastHref = ''
  while (Date.now() < deadline) {
    const document = await waitForDocument({
      discoveryUrl,
      expectedText: workspaceMarker,
      timeoutMs: Math.min(2_000, Math.max(1, deadline - Date.now()))
    })
    lastHref = document.href
    if (!lastHref.includes('/session/') && !lastHref.includes('/agent-history/')) {
      return document
    }
    await settle(100)
  }
  throw new Error(`Android hardware Back did not reach the workspace root: ${lastHref}`)
}

export async function openHostedAndroidHardwareBackNestedRoute(
  { discoveryUrl, sessionDocument, timeoutMs },
  dependencies = {}
) {
  const activate = dependencies.activate ?? activateHostedWebViewControl
  const waitForDocument = dependencies.waitForDocument ?? waitForVisibleHostedWebView
  const settle = dependencies.settle ?? delay
  await activate(sessionDocument, { kind: 'label', value: 'More session actions' })
  const actionsDocument = await waitForDocument({
    discoveryUrl,
    expectedText: 'Agent History',
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  await settle(500)
  await activate(actionsDocument, { kind: 'text', value: 'Agent History' })
  return waitForDocument({
    discoveryUrl,
    expectedText: 'Agent Session History',
    expectedHrefIncludes: '/agent-history/',
    timeoutMs
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
