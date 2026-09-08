import path from 'node:path'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'

import { openHostedIosSettings, closeHostedIosSettings } from './hosted-ios-settings-navigation.mjs'

import { terminateHostedIosWebContent } from './hosted-ios-webcontent-process.mjs'

const SWITCH_LABEL = 'Open sessions in Chat UI'

export async function verifyHostedIosChatSettings({
  deviceUdid,
  discoveryUrl,
  workspaceDocument,
  expectedWorkspace,
  runtimeDirectory,
  timeoutMs
}) {
  const args = { discoveryUrl, timeoutMs, expectedWorkspace }
  const open = (document) =>
    openHostedIosSettings(
      args,
      document,
      'Chat UI',
      '/native-chat-settings',
      'for this paired host'
    )
  const back = (document) => closeHostedIosSettings(args, document)
  let settings = await open(workspaceDocument)
  await waitReady(settings, timeoutMs)
  if (!(await checked(settings))) {
    await activateHostedWebViewControl(settings, { kind: 'label', value: SWITCH_LABEL })
  }
  await waitChecked(settings, true, timeoutMs)
  let workspace = await back(settings)
  settings = await open(workspace)
  await waitChecked(settings, true, timeoutMs)
  const previousTargetId = settings.targetId
  await terminateHostedIosWebContent(deviceUdid)
  const recoveryDeadline = Date.now() + timeoutMs
  do {
    settings = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedHrefIncludes: '/native-chat-settings',
      expectedText: 'for this paired host',
      timeoutMs: Math.max(1000, recoveryDeadline - Date.now())
    })
    if (settings.targetId !== previousTargetId) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < recoveryDeadline)
  if (settings.targetId === previousTargetId) {
    throw new Error('Settings WebView did not remount')
  }
  await waitChecked(settings, true, timeoutMs)
  const screenshot = path.join(runtimeDirectory, 'hosted-chat-settings.png')
  await captureScreenshot(deviceUdid, screenshot)
  await activateHostedWebViewControl(settings, { kind: 'label', value: SWITCH_LABEL })
  await waitChecked(settings, false, timeoutMs)
  workspace = await back(settings)
  settings = await open(workspace)
  await waitChecked(settings, false, timeoutMs)
  return {
    workspaceDocument: await back(settings),
    evidence: {
      persistenceAfterReopen: true,
      routeAndPreferenceAfterWebViewRestart: true,
      restoredTerminalDefault: true,
      screenshot
    }
  }
}

async function checked(document) {
  const value = await evaluateHostedDocumentWithRetry(
    document,
    `(() => {
      const error = document.querySelector('[role="alert"]');
      if (error?.textContent.includes('Could not')) throw new Error(error.textContent);
    const element = document.querySelector('[aria-label="${SWITCH_LABEL}"]');
    if (!element) throw new Error('Chat preference switch missing');
    if (element.disabled || element.getAttribute('aria-disabled') === 'true' ||
        element.getAttribute('aria-busy') === 'true') return 'null';
    return JSON.stringify(element.getAttribute('aria-checked') === 'true' ||
      element.checked === true || element.querySelector('input')?.checked === true);
  })()`
  )
  return JSON.parse(value)
}
async function waitChecked(document, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await checked(document)) === expected) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Chat preference did not persist the requested value')
}

async function waitReady(document, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await checked(document)) !== null) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Chat preferences did not finish loading')
}

export {
  checked as readHostedChatPreference,
  waitChecked as waitHostedChatPreference,
  waitReady as waitHostedChatPreferenceReady
}
