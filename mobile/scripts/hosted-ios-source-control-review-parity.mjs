import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import {
  readHostedIosAccessibilityLabels,
  tapHostedIosAccessibilityControl,
  tapHostedIosAccessibilityControlByLabelPrefix,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix,
  waitForHostedIosAccessibilityControlEndingWith,
  waitForHostedIosAccessibilityControlMatching
} from './hosted-ios-emulator-accessibility.mjs'
import { longPressHostedIosAccessibilityControlByLabelPrefix } from './hosted-ios-emulator-long-press.mjs'
import { assertHostedIosScreenshotParity } from './hosted-ios-screenshot-parity.mjs'
import { readHostedWebViewTextPoint } from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)
const CHANGED_FILE_LABEL_PREFIX = 'Open changed file '
export const HEADLESS_REVIEW_OPEN_ERROR = 'renderer_unavailable'

export async function captureNativeSourceControlReviewBaselines({
  deviceUdid,
  emulator,
  expectedWorkspace,
  runtimeDirectory,
  timeoutMs
}) {
  await dismissEmulatorDeveloperMenuIfPresent(emulator)
  await longPressHostedIosAccessibilityControlByLabelPrefix(
    emulator,
    expectedWorkspace,
    timeoutMs,
    undefined,
    'Source Control'
  )
  await tapHostedIosAccessibilityControl(emulator, 'Source Control', timeoutMs)
  const changedFileControl = await waitForHostedIosAccessibilityControlMatching(
    emulator,
    (node) =>
      node.label?.startsWith(CHANGED_FILE_LABEL_PREFIX) ||
      node.value?.startsWith(CHANGED_FILE_LABEL_PREFIX),
    timeoutMs
  )
  const reviewControl = await waitForHostedIosAccessibilityControlMatching(
    emulator,
    (node) =>
      nativePullRequestState(node.label) !== null || nativePullRequestState(node.value) !== null,
    timeoutMs
  )
  await waitForHostedIosAccessibilityControlEndingWith(emulator, ' on branch', timeoutMs)
  const sourceControl = await captureNativeRoute({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-source-control-portrait.png',
    title: 'Source Control',
    timeoutMs
  })
  sourceControl.changedFileLabel = accessibilityControlText(changedFileControl, (value) =>
    value.startsWith(CHANGED_FILE_LABEL_PREFIX)
  )
  sourceControl.pullRequestState =
    nativePullRequestState(reviewControl.label) ?? nativePullRequestState(reviewControl.value)
  await tapHostedIosAccessibilityControl(emulator, sourceControl.changedFileLabel, timeoutMs)
  await waitForHostedIosAccessibilityControl(emulator, 'Open review actions', timeoutMs)
  await waitForHostedIosAccessibilityControlEndingWith(emulator, ' reviewed', timeoutMs)
  const review = await captureNativeRoute({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-review-portrait.png',
    title: 'Changes',
    timeoutMs
  })
  await tapHostedIosAccessibilityControl(emulator, 'Back', timeoutMs)
  await waitForHostedIosAccessibilityControl(emulator, 'Source Control', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Back to session', timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
  const sessionOriginReviewOpen = await captureNativeSessionOriginReviewOpen({
    emulator,
    expectedWorkspace,
    timeoutMs
  })
  return { review, sessionOriginReviewOpen, sourceControl }
}

// Why: opening a changed file from a SESSION-origin Source Control sends
// files.openDiff, which needs a renderer notifier. The e2e pairs against
// `orca serve --mobile-pairing`, which has none, so the host answers
// renderer_unavailable. Capturing the native outcome lets the hosted journey
// assert "hybrid matches native on this host" instead of "hybrid fails", and it
// records `false` on a full desktop where the diff tab really opens.
export async function captureNativeSessionOriginReviewOpen({
  emulator,
  expectedWorkspace,
  timeoutMs
}) {
  if (!(await readHostedIosAccessibilityLabels(emulator)).includes('Open source control')) {
    await tapHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
    await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, 'Mobile Emulator', timeoutMs)
  }
  await tapHostedIosAccessibilityControl(emulator, 'Open source control', timeoutMs)
  await waitForHostedIosAccessibilityControl(emulator, 'Source Control', timeoutMs)
  const changedFile = await waitForHostedIosAccessibilityControlMatching(
    emulator,
    (node) =>
      node.label?.startsWith(CHANGED_FILE_LABEL_PREFIX) ||
      node.value?.startsWith(CHANGED_FILE_LABEL_PREFIX),
    timeoutMs
  )
  const changedFileLabel = accessibilityControlText(changedFile, (value) =>
    value.startsWith(CHANGED_FILE_LABEL_PREFIX)
  )
  await tapHostedIosAccessibilityControl(emulator, changedFileLabel, timeoutMs)
  const headless = await readNativeReviewOpenOutcome(emulator, timeoutMs)
  await returnNativeFromSessionOriginSourceControl(emulator, expectedWorkspace, timeoutMs)
  return { changedFileLabel, headless }
}

async function readNativeReviewOpenOutcome(emulator, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastLabels = []
  while (Date.now() < deadline) {
    lastLabels = await readHostedIosAccessibilityLabels(emulator)
    if (lastLabels.some((label) => label.includes(HEADLESS_REVIEW_OPEN_ERROR))) {
      return HEADLESS_REVIEW_OPEN_ERROR
    }
    if (!lastLabels.includes('Source Control')) {
      return false
    }
    await delay(500)
  }
  throw new Error(
    `Native session-origin reviewOpen produced neither a diff route nor ${HEADLESS_REVIEW_OPEN_ERROR}. Last labels: ${lastLabels.slice(-40).join(', ')}`
  )
}

async function returnNativeFromSessionOriginSourceControl(emulator, expectedWorkspace, timeoutMs) {
  const labels = await readHostedIosAccessibilityLabels(emulator)
  if (labels.includes('Back to session')) {
    await tapHostedIosAccessibilityControl(emulator, 'Back to session', timeoutMs)
  }
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, 'Mobile Emulator', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Back to worktrees', timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
}

function nativePullRequestState(label) {
  if (label === 'Create pull request') {
    return { kind: 'create', label }
  }
  const number = label?.match(/^Pull request #(\d+),/)?.[1]
  if (number) {
    return { kind: 'ready', label, number }
  }
  if (label?.startsWith('Pull request unavailable:')) {
    return { kind: 'unavailable', label }
  }
  return null
}

function accessibilityControlText(control, matches) {
  for (const value of [control.label, control.value]) {
    if (typeof value === 'string' && matches(value)) {
      return value
    }
  }
  throw new Error('Accessibility control lost its matched text')
}

export async function captureHostedSourceControlReviewScreen({
  deviceUdid,
  document,
  nativeBaseline,
  runtimeDirectory,
  screenshotName,
  title,
  timeoutMs
}) {
  const screenTitlePoint = await readHostedWebViewTextPoint(document, title)
  const screenshot = path.join(runtimeDirectory, screenshotName)
  const deadline = Date.now() + timeoutMs
  let lastError = new Error(`${title} did not reach screenshot parity`)
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

export function sourceControlReviewParityEvidence(nativeCapture, hostedCapture) {
  return {
    nativeScreenshot: path.basename(nativeCapture.screenshot),
    hostedScreenshot: path.basename(hostedCapture.screenshot),
    nativeScreenTitlePoint: nativeCapture.screenTitlePoint,
    hostedScreenTitlePoint: hostedCapture.screenTitlePoint,
    screenshotParity: hostedCapture.screenshotParity
  }
}

async function captureNativeRoute({
  deviceUdid,
  emulator,
  runtimeDirectory,
  screenshotName,
  title,
  timeoutMs
}) {
  const screenTitlePoint = await waitForHostedIosAccessibilityControl(emulator, title, timeoutMs)
  await delay(500)
  const screenshot = path.join(runtimeDirectory, screenshotName)
  await captureSimulatorScreenshot(deviceUdid, screenshot)
  return { screenTitlePoint, screenshot }
}

async function captureSimulatorScreenshot(deviceUdid, outputPath) {
  await execFileAsync('xcrun', ['simctl', 'io', deviceUdid, 'screenshot', outputPath])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
