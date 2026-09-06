import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  tapHostedIosAccessibilityControl,
  tapHostedIosPoint,
  waitForHostedIosAccessibilityControlMatch
} from './hosted-ios-emulator-accessibility.mjs'
import {
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { CLIPBOARD_MARKER } from './hosted-ios-terminal-clipboard-paste.mjs'

const execFileAsync = promisify(execFile)
const MOBILE_APP_BUNDLE_ID = 'com.stably.orca.mobile'
const PERMISSION_DENIAL_LABELS = ['Don’t Allow', "Don't Allow"]
const PRIVILEGED_PAGE_MARKERS = ['orca-paste-', 'data:image/']

export async function resetHostedIosPhotosPermission(deviceUdid, runCommand = execFileAsync) {
  await runCommand('xcrun', [
    'simctl',
    'privacy',
    deviceUdid,
    'reset',
    'photos',
    MOBILE_APP_BUNDLE_ID
  ])
}

export async function verifyHostedIosPhotoPermissionDenial(
  {
    discoveryUrl,
    emulator,
    orcaCli,
    pairingRuntimeUserDataPath,
    sessionDocument,
    terminalHandle,
    timeoutMs,
    worktree
  },
  operations = {}
) {
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const waitForPrompt = operations.waitForPrompt ?? waitForHostedIosAccessibilityControlMatch
  const tapPoint = operations.tapPoint ?? tapHostedIosPoint
  const readState = operations.readState ?? readHostedWebViewState
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const readTerminal = operations.readTerminal ?? readHostedRuntimeTerminalSnapshot
  const wait = operations.wait ?? delay
  await wait(500)
  const beforeTerminal = await readTerminal({
    orcaCli,
    pairingRuntimeUserDataPath,
    terminalHandle,
    worktree
  })

  let activationAttempts = 0
  let attachControlPoint = null
  let denialControl = null
  let promptError = null
  while (activationAttempts < 3 && !denialControl) {
    activationAttempts += 1
    attachControlPoint = await tapControl(emulator, 'Attach a photo', timeoutMs)
    try {
      denialControl = await waitForPrompt(
        emulator,
        PERMISSION_DENIAL_LABELS,
        Math.min(timeoutMs, 5_000)
      )
    } catch (error) {
      promptError = error
    }
  }
  if (!attachControlPoint || !denialControl) {
    throw promptError ?? new Error('Photos permission prompt did not open')
  }
  await tapPoint(emulator, denialControl)
  const denialState = await waitForHostedPageText(
    sessionDocument,
    'Photo permission denied',
    timeoutMs,
    readState
  )
  assertNoPrivilegedPageMarkers(denialState)
  const activeSessionDocument = await waitForDocument({
    discoveryUrl,
    expectedText: 'Mobile Emulator',
    expectedHrefIncludes: '/session/',
    requireInteractiveControls: false,
    timeoutMs
  })
  await wait(500)
  const afterTerminal = await readTerminal({
    orcaCli,
    pairingRuntimeUserDataPath,
    terminalHandle,
    worktree
  })
  const beforeText = terminalJourneyPayload(beforeTerminal)
  const afterText = terminalJourneyPayload(afterTerminal)
  if (afterText !== beforeText) {
    throw new Error(
      `Photo permission denial changed the Desktop terminal: before=${JSON.stringify(beforeText.slice(-240))} after=${JSON.stringify(afterText.slice(-240))}`
    )
  }

  return {
    evidence: {
      activationAttempts,
      attachControlPoint,
      denialControl: {
        label: denialControl.label,
        x: denialControl.x,
        y: denialControl.y
      },
      privilegedPageMarkers: 'absent',
      route: activeSessionDocument.href,
      terminalOutput: 'unchanged',
      toast: 'Photo permission denied'
    },
    sessionDocument: activeSessionDocument
  }
}

export function terminalJourneyPayload(snapshot) {
  const text = snapshot.join('')
  const markerIndex = text.indexOf(CLIPBOARD_MARKER)
  return markerIndex === -1 ? text : text.slice(markerIndex)
}

export async function readHostedRuntimeTerminalSnapshot({
  orcaCli,
  pairingRuntimeUserDataPath,
  terminalHandle,
  worktree
}) {
  const environment = {
    ...process.env,
    ORCA_DEV_USER_DATA_PATH: pairingRuntimeUserDataPath,
    ORCA_USER_DATA_PATH: pairingRuntimeUserDataPath
  }
  const { stdout } = await execFileAsync(
    orcaCli,
    ['terminal', 'read', '--terminal', terminalHandle, '--limit', '200', '--json'],
    {
      cwd: worktree,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000
    }
  )
  const parsed = JSON.parse(stdout)
  if (parsed.ok !== true || !Array.isArray(parsed.result?.terminal?.tail)) {
    throw new Error(parsed.error?.message ?? 'Temporary Desktop terminal snapshot failed')
  }
  return parsed.result.terminal.tail
}

async function waitForHostedPageText(document, expectedText, timeoutMs, readState) {
  const deadline = Date.now() + timeoutMs
  let lastState = null
  while (Date.now() < deadline) {
    lastState = await readState(document)
    if (lastState.bodyText.includes(expectedText)) {
      return lastState
    }
    await delay(100)
  }
  throw new Error(
    `${expectedText} did not appear in the hosted page: ${lastState?.bodyText?.slice(-240) ?? ''}`
  )
}

function assertNoPrivilegedPageMarkers(state) {
  const marker = PRIVILEGED_PAGE_MARKERS.find((candidate) => state.bodyText.includes(candidate))
  if (marker) {
    throw new Error(`Photo permission denial exposed privileged page marker: ${marker}`)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
