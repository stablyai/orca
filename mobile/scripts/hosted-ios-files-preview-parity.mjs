import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import {
  tapHostedIosAccessibilityControl,
  tapHostedIosAccessibilityControlByLabelPrefix,
  tapHostedIosPoint,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix,
  waitForHostedIosAccessibilityLabel
} from './hosted-ios-emulator-accessibility.mjs'
import { assertHostedIosScreenshotParity } from './hosted-ios-screenshot-parity.mjs'
import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  readHostedWebViewTextPoint,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { readHostedWebViewControlPoint } from './hosted-webview-control-point.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

const execFileAsync = promisify(execFile)
const FILES_STABLE_LABEL = 'Open folder Casks'
const PREVIEW_FILE_LABEL = 'Preview file orca.rb'
const PREVIEW_STABLE_LABEL = 'File preview'
const PREVIEW_STABLE_TEXT = 'cask "orca" do'

export async function captureNativeFilesPreviewBaselines({
  deviceUdid,
  emulator,
  expectedWorkspace,
  runtimeDirectory,
  timeoutMs
}) {
  await dismissEmulatorDeveloperMenuIfPresent(emulator)
  await tapHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, 'Mobile Emulator', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Open file explorer', timeoutMs)
  await waitForHostedIosAccessibilityControl(emulator, FILES_STABLE_LABEL, timeoutMs)
  const files = await captureNativeRoute({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-files-portrait.png',
    title: 'Files',
    timeoutMs
  })
  await tapHostedIosAccessibilityControl(emulator, FILES_STABLE_LABEL, timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, PREVIEW_FILE_LABEL, timeoutMs)
  await waitForHostedIosAccessibilityLabel(emulator, PREVIEW_STABLE_LABEL, timeoutMs)
  const preview = await captureNativeRoute({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-file-preview-portrait.png',
    title: 'orca.rb',
    timeoutMs
  })
  await returnNativeToWorkspaces({ emulator, expectedWorkspace, timeoutMs })
  return { files, preview }
}

export async function captureHostedFilesPreviewParity({
  deviceUdid,
  discoveryUrl,
  emulator,
  expectedWorkspace,
  nativeBaselines,
  runtimeDirectory,
  timeoutMs,
  workspaceDocument
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
  const filesDocument = await tapForHostedTransition({
    document: sessionDocument,
    emulator,
    label: 'Open file explorer',
    timeoutMs,
    resolve: (transitionTimeoutMs) =>
      waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: 'Files',
        expectedHrefIncludes: '/files/',
        timeoutMs: transitionTimeoutMs
      })
  })
  await waitForHostedLabel(filesDocument, FILES_STABLE_LABEL, timeoutMs)
  const files = await captureHostedRoute({
    deviceUdid,
    document: filesDocument,
    nativeBaseline: nativeBaselines.files,
    runtimeDirectory,
    screenshotName: 'hosted-files-portrait.png',
    title: 'Files',
    timeoutMs
  })
  await tapForHostedTransition({
    document: filesDocument,
    emulator,
    label: FILES_STABLE_LABEL,
    timeoutMs,
    resolve: (transitionTimeoutMs) =>
      waitForHostedLabel(filesDocument, PREVIEW_FILE_LABEL, transitionTimeoutMs)
  })
  await tapForHostedTransition({
    document: filesDocument,
    emulator,
    label: PREVIEW_FILE_LABEL,
    timeoutMs,
    resolve: (transitionTimeoutMs) =>
      waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: 'orca.rb',
        expectedHrefIncludes: '/files/preview/',
        timeoutMs: transitionTimeoutMs
      })
  })
  const previewDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: PREVIEW_STABLE_TEXT,
    expectedHrefIncludes: '/files/preview/',
    timeoutMs
  })
  const preview = await captureHostedRoute({
    deviceUdid,
    document: previewDocument,
    nativeBaseline: nativeBaselines.preview,
    runtimeDirectory,
    screenshotName: 'hosted-file-preview-portrait.png',
    title: 'orca.rb',
    timeoutMs
  })
  const returnedWorkspaceDocument = await returnHostedToWorkspaces({
    discoveryUrl,
    emulator,
    expectedWorkspace,
    filesDocument,
    previewDocument,
    timeoutMs
  })
  return {
    evidence: {
      files: filesPreviewParityEvidence(nativeBaselines.files, files),
      preview: filesPreviewParityEvidence(nativeBaselines.preview, preview)
    },
    workspaceDocument: returnedWorkspaceDocument
  }
}

export function filesPreviewParityEvidence(nativeCapture, hostedCapture) {
  return {
    nativeScreenshot: path.basename(nativeCapture.screenshot),
    hostedScreenshot: path.basename(hostedCapture.screenshot),
    nativeScreenTitlePoint: nativeCapture.screenTitlePoint,
    hostedScreenTitlePoint: hostedCapture.screenTitlePoint,
    screenshotParity: hostedCapture.screenshotParity
  }
}

async function captureNativeRoute(options) {
  const screenTitlePoint = await waitForHostedIosAccessibilityControl(
    options.emulator,
    options.title,
    options.timeoutMs
  )
  await delay(500)
  const screenshot = path.join(options.runtimeDirectory, options.screenshotName)
  await captureSimulatorScreenshot(options.deviceUdid, screenshot)
  return { screenTitlePoint, screenshot }
}

async function captureHostedRoute(options) {
  const screenTitlePoint = await readHostedWebViewTextPoint(options.document, options.title)
  const screenshot = path.join(options.runtimeDirectory, options.screenshotName)
  const deadline = Date.now() + options.timeoutMs
  let lastError = new Error(`${options.title} did not reach screenshot parity`)
  while (Date.now() < deadline) {
    await delay(500)
    await captureSimulatorScreenshot(options.deviceUdid, screenshot)
    try {
      const screenshotParity = await assertHostedIosScreenshotParity({
        hostedLandmark: screenTitlePoint,
        hostedScreenshot: screenshot,
        nativeLandmark: options.nativeBaseline.screenTitlePoint,
        nativeScreenshot: options.nativeBaseline.screenshot
      })
      return { screenTitlePoint, screenshot, screenshotParity }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function returnNativeToWorkspaces({ emulator, expectedWorkspace, timeoutMs }) {
  await tapHostedIosAccessibilityControl(emulator, 'Back to files', timeoutMs)
  await waitForHostedIosAccessibilityControl(emulator, FILES_STABLE_LABEL, timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Back to session', timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, 'Mobile Emulator', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Back to worktrees', timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
}

async function returnHostedToWorkspaces(options) {
  const filesDocument = await tapForHostedTransition({
    document: options.previewDocument,
    emulator: options.emulator,
    label: 'Back to files',
    timeoutMs: options.timeoutMs,
    resolve: (transitionTimeoutMs) =>
      waitForVisibleHostedWebView({
        discoveryUrl: options.discoveryUrl,
        expectedText: 'Files',
        expectedHrefIncludes: '/files/',
        timeoutMs: transitionTimeoutMs
      })
  })
  const sessionDocument = await tapForHostedTransition({
    document: filesDocument,
    emulator: options.emulator,
    label: 'Back to session',
    timeoutMs: options.timeoutMs,
    resolve: (transitionTimeoutMs) =>
      waitForVisibleHostedWebView({
        discoveryUrl: options.discoveryUrl,
        expectedText: 'Mobile Emulator',
        expectedHrefIncludes: '/session/',
        timeoutMs: transitionTimeoutMs
      })
  })
  return tapForHostedTransition({
    document: sessionDocument,
    emulator: options.emulator,
    label: 'Back to worktrees',
    timeoutMs: options.timeoutMs,
    resolve: (transitionTimeoutMs) =>
      waitForVisibleHostedWebView({
        discoveryUrl: options.discoveryUrl,
        expectedText: options.expectedWorkspace,
        timeoutMs: transitionTimeoutMs
      })
  })
}

async function tapForHostedTransition({ document, emulator, label, resolve, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  let lastError = new Error(`${label} did not transition`)
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
    try {
      await tapHostedControl(emulator, document, label, timeoutMs, attempt)
      return await resolve(Math.min(3_000, Math.max(1_000, deadline - Date.now())))
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function tapHostedControl(emulator, document, label, timeoutMs, attempt) {
  if (attempt === 0) {
    try {
      await tapHostedIosAccessibilityControl(emulator, label, Math.min(timeoutMs, 5_000))
      return
    } catch {
      // WebKit can omit a descendant while refreshing its accessibility tree.
    }
  }
  const point = await readHostedWebViewControlPoint(document, label)
  await tapHostedIosPoint(emulator, point)
}

async function waitForHostedLabel(document, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = await readHostedWebViewState(document)
    if (state.labels.includes(label)) {
      return state
    }
    await delay(250)
  }
  throw new Error(`${label} was not present. Last labels: ${(state?.labels ?? []).join(', ')}`)
}

async function captureSimulatorScreenshot(deviceUdid, outputPath) {
  await execFileAsync('xcrun', ['simctl', 'io', deviceUdid, 'screenshot', outputPath])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
