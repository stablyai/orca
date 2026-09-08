import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { EMULATOR_AGENT_HISTORY_TITLE } from './emulator-agent-history-fixture.mjs'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import {
  rotateHostedIosEmulator,
  tapHostedIosAccessibilityControl,
  tapHostedIosAccessibilityControlByLabelPrefix,
  typeHostedIosText,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix
} from './hosted-ios-emulator-accessibility.mjs'
import { assertHostedIosScreenshotParity } from './hosted-ios-screenshot-parity.mjs'
import { readHostedWebViewTextPoint } from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)
const AGENT_HISTORY_SEARCH_PLACEHOLDER = 'Search sessions, repo:, path:'
const AGENT_HISTORY_SEARCH_QUERY = 'hybrid agent history fixture'

export async function captureNativeAgentHistoryBaseline({
  deviceUdid,
  emulator,
  expectedWorkspace,
  runtimeDirectory,
  timeoutMs
}) {
  await openNativeAgentHistoryBaseline({ emulator, expectedWorkspace, timeoutMs })
  const portrait = await captureAgentHistoryOrientation({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-agent-history-portrait.png',
    timeoutMs
  })
  const landscape = await captureRotatedAgentHistoryOrientation({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-agent-history-landscape.png',
    timeoutMs
  })
  return { portrait, landscape }
}

export async function openNativeAgentHistoryBaseline({ emulator, expectedWorkspace, timeoutMs }) {
  await rotateHostedIosEmulator(emulator, 'portrait')
  await delay(500)
  await dismissEmulatorDeveloperMenuIfPresent(emulator)
  await tapHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'More session actions', timeoutMs)
  await tapHostedIosAccessibilityControlByLabelPrefix(emulator, 'Agent History', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, AGENT_HISTORY_SEARCH_PLACEHOLDER, timeoutMs)
  await delay(500)
  await typeHostedIosText(emulator, AGENT_HISTORY_SEARCH_QUERY)
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    emulator,
    EMULATOR_AGENT_HISTORY_TITLE,
    timeoutMs
  )
  await tapHostedIosAccessibilityControl(emulator, 'Agent Session History', timeoutMs)
}

export async function captureHostedAgentHistoryParity({
  document,
  deviceUdid,
  emulator,
  nativeBaseline,
  runtimeDirectory,
  timeoutMs
}) {
  const portrait = await captureHostedAgentHistoryOrientation({
    document,
    deviceUdid,
    runtimeDirectory,
    screenshotName: 'hosted-agent-history-portrait.png'
  })
  portrait.screenshotParity = await compareAgentHistoryOrientation(
    nativeBaseline.portrait,
    portrait
  )
  const landscape = await captureRotatedAgentHistoryOrientation({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'hosted-agent-history-landscape.png',
    timeoutMs
  })
  landscape.screenshotParity = await compareAgentHistoryOrientation(
    nativeBaseline.landscape,
    landscape
  )
  return { portrait, landscape }
}

export async function captureAgentHistorySimulatorScreenshot(deviceUdid, outputPath) {
  await execFileAsync('xcrun', ['simctl', 'io', deviceUdid, 'screenshot', outputPath])
}

export function agentHistoryParityEvidence(nativeCapture, hostedCapture) {
  return {
    nativeScreenshot: path.basename(nativeCapture.screenshot),
    hostedScreenshot: path.basename(hostedCapture.screenshot),
    nativeScreenTitlePoint: nativeCapture.screenTitlePoint,
    hostedScreenTitlePoint: hostedCapture.screenTitlePoint,
    screenshotParity: hostedCapture.screenshotParity
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function captureAgentHistoryOrientation({
  deviceUdid,
  emulator,
  runtimeDirectory,
  screenshotName,
  timeoutMs
}) {
  const screenTitlePoint = await waitForHostedIosAccessibilityControl(
    emulator,
    'Agent Session History',
    timeoutMs
  )
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    emulator,
    EMULATOR_AGENT_HISTORY_TITLE,
    timeoutMs
  )
  const screenshot = path.join(runtimeDirectory, screenshotName)
  await captureAgentHistorySimulatorScreenshot(deviceUdid, screenshot)
  return { screenshot, screenTitlePoint }
}

async function captureHostedAgentHistoryOrientation({
  document,
  deviceUdid,
  runtimeDirectory,
  screenshotName
}) {
  const screenTitlePoint = await readHostedWebViewTextPoint(document, 'Agent Session History')
  const screenshot = path.join(runtimeDirectory, screenshotName)
  await captureAgentHistorySimulatorScreenshot(deviceUdid, screenshot)
  return { screenshot, screenTitlePoint }
}

async function captureRotatedAgentHistoryOrientation(options) {
  await rotateHostedIosEmulator(options.emulator, 'landscape_left')
  try {
    await delay(1_000)
    const screenshot = path.join(options.runtimeDirectory, options.screenshotName)
    await captureAgentHistorySimulatorScreenshot(options.deviceUdid, screenshot)
    return { screenshot, screenTitlePoint: null }
  } finally {
    await rotateHostedIosEmulator(options.emulator, 'portrait')
    await delay(1_000)
  }
}

function compareAgentHistoryOrientation(nativeCapture, hostedCapture) {
  return assertHostedIosScreenshotParity({
    nativeScreenshot: nativeCapture.screenshot,
    hostedScreenshot: hostedCapture.screenshot,
    nativeLandmark: nativeCapture.screenTitlePoint,
    hostedLandmark: hostedCapture.screenTitlePoint
  })
}
