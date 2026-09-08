import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import {
  tapHostedIosPoint,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix
} from './hosted-ios-emulator-accessibility.mjs'
import { assertHostedIosScreenshotParity } from './hosted-ios-screenshot-parity.mjs'
import {
  readHostedWebViewTextPoint,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)
const ACCOUNTS_STABLE_TEXT = 'Add or re-authenticate accounts from desktop Settings → Accounts.'
const ACCOUNTS_TOOLBAR_X = 0.8
const BACK_X = 0.075

export async function captureNativeAccountsBaseline({
  deviceUdid,
  emulator,
  expectedWorkspace,
  runtimeDirectory,
  timeoutMs
}) {
  await dismissEmulatorDeveloperMenuIfPresent(emulator)
  const filterPoint = await waitForHostedIosAccessibilityControl(emulator, 'Filter', timeoutMs)
  // The existing non-embedded Accounts icon has no native accessibility label.
  await tapHostedIosPoint(emulator, { x: ACCOUNTS_TOOLBAR_X, y: filterPoint.y })
  await waitForHostedIosAccessibilityControl(emulator, ACCOUNTS_STABLE_TEXT, timeoutMs)
  const accounts = await captureNativeAccounts({
    deviceUdid,
    emulator,
    runtimeDirectory,
    timeoutMs
  })
  await tapHostedIosPoint(emulator, accountsBackPoint(accounts.screenTitlePoint))
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
  return accounts
}

export async function captureHostedAccountsParity({
  deviceUdid,
  discoveryUrl,
  emulator,
  expectedWorkspace,
  nativeBaseline,
  runtimeDirectory,
  timeoutMs,
  workspaceDocument
}) {
  await openHostedAccounts(emulator, workspaceDocument)
  const accountsDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: ACCOUNTS_STABLE_TEXT,
    expectedHrefIncludes: '/accounts',
    timeoutMs
  })
  const accounts = await captureHostedAccounts({
    deviceUdid,
    document: accountsDocument,
    nativeBaseline,
    runtimeDirectory,
    timeoutMs
  })
  await tapHostedIosPoint(emulator, accountsBackPoint(accounts.screenTitlePoint))
  const returnedWorkspaceDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: expectedWorkspace,
    timeoutMs
  })
  return {
    evidence: accountsParityEvidence(nativeBaseline, accounts),
    workspaceDocument: returnedWorkspaceDocument
  }
}

async function openHostedAccounts(emulator, document) {
  const filterPoint = await readHostedWebViewTextPoint(document, 'Filter')
  await tapHostedIosPoint(emulator, { x: ACCOUNTS_TOOLBAR_X, y: filterPoint.y })
}

export function accountsParityEvidence(nativeCapture, hostedCapture) {
  return {
    nativeScreenshot: path.basename(nativeCapture.screenshot),
    hostedScreenshot: path.basename(hostedCapture.screenshot),
    nativeScreenTitlePoint: nativeCapture.screenTitlePoint,
    hostedScreenTitlePoint: hostedCapture.screenTitlePoint,
    screenshotParity: hostedCapture.screenshotParity
  }
}

async function captureNativeAccounts({ deviceUdid, emulator, runtimeDirectory, timeoutMs }) {
  const screenTitlePoint = await waitForHostedIosAccessibilityControl(
    emulator,
    'Accounts',
    timeoutMs
  )
  await delay(500)
  const screenshot = path.join(runtimeDirectory, 'native-accounts-portrait.png')
  await captureSimulatorScreenshot(deviceUdid, screenshot)
  return { screenTitlePoint, screenshot }
}

async function captureHostedAccounts({
  deviceUdid,
  document,
  nativeBaseline,
  runtimeDirectory,
  timeoutMs
}) {
  const screenTitlePoint = await readHostedWebViewTextPoint(document, 'Accounts')
  const screenshot = path.join(runtimeDirectory, 'hosted-accounts-portrait.png')
  const deadline = Date.now() + timeoutMs
  let lastError = new Error('Accounts did not reach screenshot parity')
  while (Date.now() < deadline) {
    await delay(500)
    await captureSimulatorScreenshot(deviceUdid, screenshot)
    try {
      const screenshotParity = await assertHostedIosScreenshotParity({
        hostedLandmark: screenTitlePoint,
        hostedScreenshot: screenshot,
        nativeLandmark: nativeBaseline.screenTitlePoint,
        nativeScreenshot: nativeBaseline.screenshot
      })
      return { screenTitlePoint, screenshot, screenshotParity }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function accountsBackPoint(titlePoint) {
  return { x: BACK_X, y: titlePoint.y }
}

async function captureSimulatorScreenshot(deviceUdid, outputPath) {
  await execFileAsync('xcrun', ['simctl', 'io', deviceUdid, 'screenshot', outputPath])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
