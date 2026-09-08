import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import { waitForHostedIosAccessibilityControl } from './hosted-ios-emulator-accessibility.mjs'
import { assertHostedIosScreenshotParity } from './hosted-ios-screenshot-parity.mjs'
import { readHostedWebViewTextPoint } from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)

export async function captureNativeWorkspaceBaseline({
  deviceUdid,
  emulator,
  runtimeDirectory,
  timeoutMs
}) {
  await dismissEmulatorDeveloperMenuIfPresent(emulator)
  const filterPoint = await waitForHostedIosAccessibilityControl(emulator, 'Filter', timeoutMs)
  await delay(500)
  const screenshot = path.join(runtimeDirectory, 'native-workspace-portrait.png')
  await captureSimulatorScreenshot(deviceUdid, screenshot)
  return { filterPoint, screenshot }
}

export async function captureHostedWorkspaceParity({
  deviceUdid,
  document,
  nativeBaseline,
  runtimeDirectory,
  timeoutMs
}) {
  const filterPoint = await readHostedWebViewTextPoint(document, 'Filter')
  const screenshot = path.join(runtimeDirectory, 'hosted-workspace-portrait.png')
  const deadline = Date.now() + timeoutMs
  let lastError = new Error('Workspace did not reach screenshot parity')
  while (Date.now() < deadline) {
    await delay(500)
    await captureSimulatorScreenshot(deviceUdid, screenshot)
    try {
      const screenshotParity = await assertHostedIosScreenshotParity({
        hostedLandmark: filterPoint,
        hostedScreenshot: screenshot,
        nativeLandmark: nativeBaseline.filterPoint,
        nativeScreenshot: nativeBaseline.screenshot
      })
      return workspaceParityEvidence(nativeBaseline, {
        filterPoint,
        screenshot,
        screenshotParity
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export function workspaceParityEvidence(nativeCapture, hostedCapture) {
  return {
    nativeScreenshot: path.basename(nativeCapture.screenshot),
    hostedScreenshot: path.basename(hostedCapture.screenshot),
    nativeFilterPoint: nativeCapture.filterPoint,
    hostedFilterPoint: hostedCapture.filterPoint,
    screenshotParity: hostedCapture.screenshotParity
  }
}

async function captureSimulatorScreenshot(deviceUdid, outputPath) {
  await execFileAsync('xcrun', ['simctl', 'io', deviceUdid, 'screenshot', outputPath])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
