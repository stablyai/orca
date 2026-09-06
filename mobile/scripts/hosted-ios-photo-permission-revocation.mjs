import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  runHostedIosEmulatorCommand,
  tapHostedIosAccessibilityControl,
  tapHostedIosPoint,
  waitForHostedIosAccessibilityLabelToDisappear,
  waitForHostedIosAccessibilityControlMatch
} from './hosted-ios-emulator-accessibility.mjs'
import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import { openHostedIosHybridRoute } from './hosted-ios-hybrid-route-handoff.mjs'
import {
  readHostedRuntimeTerminalSnapshot,
  terminalJourneyPayload
} from './hosted-ios-photo-permission-denial.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

const execFileAsync = promisify(execFile)
const MOBILE_APP_BUNDLE_ID = 'com.stably.orca.mobile'
const FULL_ACCESS_LABEL = 'Allow Full Access'
const PICKER_CANCEL_LABELS = ['Cancel']
const PICKER_ENTRY_LABELS = [...PICKER_CANCEL_LABELS, FULL_ACCESS_LABEL]
const PRIVILEGED_PAGE_MARKERS = ['orca-paste-', 'data:image/']

export async function grantHostedIosPhotosPermission(deviceUdid, runCommand = execFileAsync) {
  await changeHostedIosPhotosPermission('grant', deviceUdid, runCommand)
}

export async function revokeHostedIosPhotosPermission(deviceUdid, runCommand = execFileAsync) {
  await changeHostedIosPhotosPermission('revoke', deviceUdid, runCommand)
}

export async function launchHostedIosMobileApp(deviceUdid, runCommand = execFileAsync) {
  await runCommand('xcrun', ['simctl', 'launch', deviceUdid, MOBILE_APP_BUNDLE_ID])
}

export async function backgroundHostedIosMobileApp(
  emulator,
  runCommand = runHostedIosEmulatorCommand
) {
  await runCommand(emulator, ['button', 'home'])
}

export async function verifyHostedIosPhotoPermissionRevocation(
  {
    deviceUdid,
    discoveryUrl,
    emulator,
    expectedWorkspace,
    orcaCli,
    pairingRuntimeUserDataPath,
    sessionDocument,
    terminalHandle,
    timeoutMs,
    worktree
  },
  operations = {}
) {
  const grantPermission = operations.grantPermission ?? grantHostedIosPhotosPermission
  const revokePermission = operations.revokePermission ?? revokeHostedIosPhotosPermission
  const launchApp = operations.launchApp ?? launchHostedIosMobileApp
  const backgroundApp = operations.backgroundApp ?? backgroundHostedIosMobileApp
  const dismissDeveloperMenu =
    operations.dismissDeveloperMenu ?? dismissEmulatorDeveloperMenuIfPresent
  const openHybridRoute = operations.openHybridRoute ?? openHostedIosHybridRoute
  const activateWorkspace = operations.activateWorkspace ?? activateHostedWorkspaceRow
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const waitForControl = operations.waitForControl ?? waitForHostedIosAccessibilityControlMatch
  const waitForPickerDismissal =
    operations.waitForPickerDismissal ?? waitForHostedIosAccessibilityLabelToDisappear
  const tapPoint = operations.tapPoint ?? tapHostedIosPoint
  const readState = operations.readState ?? readHostedWebViewState
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const readTerminal = operations.readTerminal ?? readHostedRuntimeTerminalSnapshot
  const wait = operations.wait ?? delay
  const beforeTerminal = await readTerminal({
    orcaCli,
    pairingRuntimeUserDataPath,
    terminalHandle,
    worktree
  })

  await grantPermission(deviceUdid)
  await launchApp(deviceUdid)
  const grantedSession = await restoreHostedIosSessionAfterLaunch({
    activateWorkspace,
    discoveryUrl,
    dismissDeveloperMenu,
    emulator,
    expectedWorkspace,
    openHybridRoute,
    timeoutMs,
    waitForDocument
  })
  let activeSessionDocument = grantedSession.document
  assertSessionRoute(activeSessionDocument)
  const grantPrivateOriginRotated =
    hostedPrivateOrigin(sessionDocument.href) !== hostedPrivateOrigin(activeSessionDocument.href)
  const grantWorkspaceAuthorityRotated =
    hostedWorkspaceAuthority(sessionDocument.href) !==
    hostedWorkspaceAuthority(activeSessionDocument.href)
  assertPrivateOriginRotated(grantPrivateOriginRotated, 'grant')
  assertWorkspaceAuthorityRotated(grantWorkspaceAuthorityRotated, 'grant')
  const grantedAttachControlPoint = await tapControl(emulator, 'Attach a photo', timeoutMs)
  let pickerControl = await waitForControl(
    emulator,
    PICKER_ENTRY_LABELS,
    Math.min(timeoutMs, 10_000)
  )
  let grantPermissionPrompt = 'not-shown'
  if (pickerControl.label === FULL_ACCESS_LABEL) {
    await tapPoint(emulator, pickerControl)
    grantPermissionPrompt = 'allowed-full-access'
    pickerControl = await waitForControl(
      emulator,
      PICKER_CANCEL_LABELS,
      Math.min(timeoutMs, 10_000)
    )
  }
  const pickerCancelControl = pickerControl
  await backgroundApp(emulator)
  await wait(500)
  await launchApp(deviceUdid)
  const resumedPickerControl = await waitForControl(
    emulator,
    PICKER_CANCEL_LABELS,
    Math.min(timeoutMs, 5_000)
  )
  await tapPoint(emulator, resumedPickerControl)
  await waitForPickerDismissal(emulator, 'Cancel', Math.min(timeoutMs, 5_000))
  const interruptedSession = await restoreHostedIosSessionAfterLaunch({
    activateWorkspace,
    discoveryUrl,
    dismissDeveloperMenu,
    emulator,
    expectedWorkspace,
    openHybridRoute,
    timeoutMs,
    waitForDocument
  })
  activeSessionDocument = interruptedSession.document
  assertSessionRoute(activeSessionDocument)
  const interruptionPrivateOriginRetained =
    hostedPrivateOrigin(grantedSession.document.href) ===
    hostedPrivateOrigin(activeSessionDocument.href)
  const interruptionWorkspaceAuthorityRetained =
    hostedWorkspaceAuthority(grantedSession.document.href) ===
    hostedWorkspaceAuthority(activeSessionDocument.href)
  assertInterruptionAuthorityLifecycle(
    interruptedSession.recovery,
    interruptionPrivateOriginRetained,
    interruptionWorkspaceAuthorityRetained
  )
  assertNoPrivilegedPageMarkers(await readState(activeSessionDocument))

  await revokePermission(deviceUdid)
  await launchApp(deviceUdid)
  const revokedSession = await restoreHostedIosSessionAfterLaunch({
    activateWorkspace,
    discoveryUrl,
    dismissDeveloperMenu,
    emulator,
    expectedWorkspace,
    openHybridRoute,
    timeoutMs,
    waitForDocument
  })
  activeSessionDocument = revokedSession.document
  assertSessionRoute(activeSessionDocument)
  const revocationPrivateOriginRotated =
    hostedPrivateOrigin(grantedSession.document.href) !==
    hostedPrivateOrigin(activeSessionDocument.href)
  const revocationWorkspaceAuthorityRotated =
    hostedWorkspaceAuthority(grantedSession.document.href) !==
    hostedWorkspaceAuthority(activeSessionDocument.href)
  assertPrivateOriginRotated(revocationPrivateOriginRotated, 'revocation')
  assertWorkspaceAuthorityRotated(revocationWorkspaceAuthorityRotated, 'revocation')
  await wait(500)
  const revokedAttachControlPoint = await tapControl(emulator, 'Attach a photo', timeoutMs)
  const denialState = await waitForHostedPageText(
    activeSessionDocument,
    'Photo permission denied',
    timeoutMs,
    readState
  )
  assertNoPrivilegedPageMarkers(denialState)
  await wait(500)
  const afterTerminal = await readTerminal({
    orcaCli,
    pairingRuntimeUserDataPath,
    terminalHandle,
    worktree
  })
  if (terminalJourneyPayload(afterTerminal) !== terminalJourneyPayload(beforeTerminal)) {
    throw new Error('Photos permission revocation changed the Desktop terminal')
  }

  return {
    evidence: {
      grantedAttachControlPoint,
      grantPrivateOriginRotated,
      grantPermissionPrompt,
      grantSessionRecovery: grantedSession.recovery,
      grantWorkspaceAuthorityRotated,
      interruptionPrivateOrigin: interruptionPrivateOriginRetained ? 'retained' : 'rotated',
      interruptionSessionRecovery: interruptedSession.recovery,
      interruptionWorkspaceAuthority: interruptionWorkspaceAuthorityRetained
        ? 'retained'
        : 'rotated',
      permissionState: 'revoked-after-grant',
      pickerInterruption: 'resumed-then-cancelled',
      pickerCancelControl,
      privilegedPageMarkers: 'absent',
      revokedAttachControlPoint,
      resumedPickerControl,
      revocationPrivateOriginRotated,
      revocationSessionRecovery: revokedSession.recovery,
      revocationWorkspaceAuthorityRotated,
      route: activeSessionDocument.href,
      routeRestored: true,
      terminalOutput: 'unchanged',
      toast: 'Photo permission denied'
    },
    sessionDocument: activeSessionDocument
  }
}

async function changeHostedIosPhotosPermission(action, deviceUdid, runCommand) {
  await runCommand('xcrun', [
    'simctl',
    'privacy',
    deviceUdid,
    action,
    'photos',
    MOBILE_APP_BUNDLE_ID
  ])
}

function waitForSessionDocument(discoveryUrl, timeoutMs, waitForDocument, expectedWorkspace) {
  return waitForDocument({
    discoveryUrl,
    expectedText: expectedWorkspace,
    expectedHrefIncludes: '/session/',
    requireInteractiveControls: false,
    timeoutMs
  })
}

async function restoreHostedIosSessionAfterLaunch({
  activateWorkspace,
  discoveryUrl,
  dismissDeveloperMenu,
  emulator,
  expectedWorkspace,
  openHybridRoute,
  timeoutMs,
  waitForDocument
}) {
  await dismissDeveloperMenu(emulator)
  try {
    return {
      document: await waitForSessionDocument(
        discoveryUrl,
        Math.min(timeoutMs, 5_000),
        waitForDocument,
        expectedWorkspace
      ),
      recovery: 'session-retained'
    }
  } catch {
    // Permission changes can cold-launch outside the experimental route.
  }
  await openHybridRoute(emulator, timeoutMs)
  const workspaceDocument = await waitForDocument({
    discoveryUrl,
    expectedText: expectedWorkspace,
    timeoutMs
  })
  // Why: cold resume can land the hybrid route on the session itself; the row only exists on the list.
  if (!isSessionRoute(workspaceDocument)) {
    await activateWorkspace(
      workspaceDocument,
      expectedWorkspace,
      activateHostedWebViewControl,
      timeoutMs,
      () =>
        waitForDocument({
          discoveryUrl,
          expectedText: expectedWorkspace,
          timeoutMs
        })
    )
  }
  return {
    document: await waitForSessionDocument(
      discoveryUrl,
      timeoutMs,
      waitForDocument,
      expectedWorkspace
    ),
    recovery: 'hybrid-route-handoff'
  }
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
    `${expectedText} did not appear after Photos revocation: ${lastState?.bodyText?.slice(-240) ?? ''}`
  )
}

function assertNoPrivilegedPageMarkers(state) {
  const marker = PRIVILEGED_PAGE_MARKERS.find((candidate) => state.bodyText.includes(candidate))
  if (marker) {
    throw new Error(`Photos permission revocation exposed privileged page marker: ${marker}`)
  }
}

function isSessionRoute(document) {
  return new URL(document.href).pathname.split('/').at(-2) === 'session'
}

function assertSessionRoute(document) {
  if (!isSessionRoute(document)) {
    throw new Error(`Photos permission change did not restore the session route: ${document.href}`)
  }
}

function hostedPrivateOrigin(href) {
  return new URL(href).host
}

function hostedWorkspaceAuthority(href) {
  return new URL(href).pathname.split('/').at(-1)
}

function assertPrivateOriginRotated(rotated, lifecycleStage) {
  if (!rotated) {
    throw new Error(`Photos permission ${lifecycleStage} reused the private WebView origin`)
  }
}

function assertWorkspaceAuthorityRotated(rotated, lifecycleStage) {
  if (!rotated) {
    throw new Error(`Photos permission ${lifecycleStage} reused opaque workspace authority`)
  }
}

function assertInterruptionAuthorityLifecycle(
  recovery,
  privateOriginRetained,
  workspaceAuthorityRetained
) {
  const expectedRetained = recovery === 'session-retained'
  if (
    privateOriginRetained !== expectedRetained ||
    workspaceAuthorityRetained !== expectedRetained
  ) {
    throw new Error(`Photos picker interruption authority did not match ${recovery} recovery`)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
