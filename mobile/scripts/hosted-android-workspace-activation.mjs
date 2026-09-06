import { tapHostedAndroidPoint } from './hosted-android-emulator-accessibility.mjs'
import {
  activateHostedWebViewControl,
  readHostedWebViewTextPoint
} from './hosted-webview-cdp-session.mjs'
import { readStableHostedAndroidWebViewPoint } from './hosted-android-webview-touch-point.mjs'

export async function prepareHostedAndroidWorkspaceInput(emulator) {
  await tapHostedAndroidPoint(emulator, { x: 0.5, y: 0.75 })
  // Why: the native recovery surface can intercept hosted touches immediately after pairing.
  await delay(10_000)
}

export async function activateHostedAndroidWorkspaceControl(emulator, document, target) {
  if (target.kind === 'label') {
    throw new Error(`Hosted WebView control was not found: ${target.value}`)
  }
  if (target.reveal && target.occurrence === undefined) {
    return activateHostedWebViewControl(document, target)
  }
  if (target.reveal) {
    await readHostedWebViewTextPoint(document, target.value, undefined, {
      ignoreCase: target.ignoreCase,
      occurrence: target.occurrence,
      reveal: true
    })
    await delay(250)
  }
  const point = await readStableHostedAndroidWebViewPoint(() =>
    readHostedWebViewTextPoint(document, target.value, undefined, {
      ignoreCase: target.ignoreCase,
      occurrence: target.occurrence
    })
  )
  await tapHostedAndroidPoint(emulator, point)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
