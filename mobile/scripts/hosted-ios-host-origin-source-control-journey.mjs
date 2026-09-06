import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { tapHostedIosAccessibilityControl } from './hosted-ios-emulator-accessibility.mjs'
import { longPressHostedIosAccessibilityControlByLabelPrefix } from './hosted-ios-emulator-long-press.mjs'

const CHANGED_FILE_PREFIX = 'Open changed file '
const REVIEW_CONTROLS = ['Back', 'Open review actions']

export async function verifyHostedHostOriginSourceControlJourney({
  discoveryUrl,
  emulator,
  nativeBaseline,
  timeoutMs,
  workspaceName,
  operations = {}
}) {
  const activate = operations.activate ?? activateHostedWebViewControl
  const longPress = operations.longPress ?? longPressHostedIosAccessibilityControlByLabelPrefix
  const tapNative = operations.tapNative ?? tapHostedIosAccessibilityControl
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const readState = operations.readState ?? readHostedWebViewState

  await longPress(emulator, workspaceName, timeoutMs, undefined, 'Source Control')
  await tapNative(emulator, 'Source Control', timeoutMs)
  const sourceControl = await waitForDocument({
    discoveryUrl,
    expectedHrefIncludes: '/source-control/',
    expectedText: 'Source Control',
    timeoutMs
  })
  const sourceState = await waitForChangedFileState(sourceControl, timeoutMs, readState)
  const changedFileLabel = nativeBaseline.changedFileLabel
  if (!sourceState.labels.includes(changedFileLabel)) {
    throw new Error(`Host-origin Source Control is missing ${changedFileLabel}`)
  }

  await activate(sourceControl, { kind: 'label', value: changedFileLabel })
  const review = await waitForDocument({
    discoveryUrl,
    expectedHrefIncludes: '/review/',
    expectedText: 'reviewed',
    timeoutMs
  })
  const reviewState = await waitForReviewControls(review, timeoutMs, readState)

  await activate(review, { kind: 'label', value: 'Back' })
  const returnedSourceControl = await waitForDocument({
    discoveryUrl,
    expectedHrefIncludes: '/source-control/',
    expectedText: 'Source Control',
    timeoutMs
  })
  await activate(returnedSourceControl, { kind: 'label', value: 'Back to session' })
  const returnedWorkspace = await waitForWorkspaceRoot({
    discoveryUrl,
    expectedText: workspaceName,
    timeoutMs,
    waitForDocument
  })

  return {
    changedFileLabel,
    reviewRoute: reviewState.href,
    sourceControlRoute: sourceState.href,
    workspaceDocument: returnedWorkspace
  }
}

async function waitForWorkspaceRoot({ discoveryUrl, expectedText, timeoutMs, waitForDocument }) {
  const deadline = Date.now() + timeoutMs
  let document
  while (Date.now() < deadline) {
    document = await waitForDocument({
      discoveryUrl,
      expectedText,
      timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now()))
    })
    if (isHostedRoot(document.href)) {
      return document
    }
    await delay(250)
  }
  throw new Error(
    `Host-origin Source Control did not return to the workspace list: ${document?.href}`
  )
}

function isHostedRoot(href) {
  try {
    return new URL(href).pathname === '/'
  } catch {
    return false
  }
}

async function waitForReviewControls(document, timeoutMs, readState) {
  const deadline = Date.now() + Math.min(timeoutMs, 10_000)
  let state
  while (Date.now() < deadline) {
    state = await readState(document)
    if (REVIEW_CONTROLS.every((label) => state.labels.includes(label))) {
      return state
    }
    await delay(250)
  }
  const missing = REVIEW_CONTROLS.filter((label) => !state?.labels.includes(label))
  throw new Error(
    `Host-origin Review is missing ${missing.join(', ')}. Labels: ${state?.labels.join(', ') ?? ''}`
  )
}

async function waitForChangedFileState(document, timeoutMs, readState) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = await readState(document)
    if (state.labels.some((label) => label.startsWith(CHANGED_FILE_PREFIX))) {
      return state
    }
    await delay(250)
  }
  throw new Error('Host-origin Source Control has no changed file')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
