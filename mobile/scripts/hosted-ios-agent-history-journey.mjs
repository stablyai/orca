import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  setHostedWebViewInput,
  startHostedWebViewConnectionObservation,
  waitForHostedWebViewConnectionSequence,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import {
  EMULATOR_AGENT_HISTORY_PREVIEW_MARKER,
  EMULATOR_AGENT_HISTORY_TITLE
} from './emulator-agent-history-fixture.mjs'
import {
  agentHistoryParityEvidence,
  captureHostedAgentHistoryParity
} from './hosted-ios-agent-history-parity.mjs'
import { tapHostedIosAccessibilityControl } from './hosted-ios-emulator-accessibility.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

export async function verifyHostedAgentHistoryJourney({
  discoveryUrl,
  launcher,
  emulator,
  nativeAgentHistory,
  runtimeDirectory,
  workspaceDocument,
  expectedWorkspace,
  timeoutMs
}) {
  await delay(500)
  const sessionDocument = await evidenceStep('open hosted workspace', async () => {
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
    return waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: 'Mobile Emulator',
      expectedHrefIncludes: '/session/',
      timeoutMs
    })
  })
  await delay(500)
  const actionsDocument = await evidenceStep('open Session actions', async () => {
    await activateHostedWebViewControl(sessionDocument, {
      kind: 'label',
      value: 'More session actions'
    })
    return waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: 'Agent History',
      timeoutMs
    })
  })
  await delay(500)
  await evidenceStep('open Agent History', async () => {
    await activateHostedWebViewControl(actionsDocument, {
      kind: 'text',
      value: 'Agent History'
    })
    return waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: 'Agent Session History',
      expectedHrefIncludes: '/agent-history/',
      timeoutMs
    })
  })
  await delay(1000)
  let activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: 'Workspace',
    expectedHrefIncludes: '/agent-history/',
    timeoutMs
  })
  const state = await evidenceStep('read Agent History state', () =>
    readHostedWebViewState(activeHistoryDocument)
  )
  for (const expected of ['Workspace', 'Project', 'All']) {
    if (!state.bodyText.includes(expected)) {
      throw new Error(`Agent History is missing its ${expected} scope.`)
    }
  }
  if (!state.labels.includes('Back') || !state.labels.includes('Refresh agent sessions')) {
    throw new Error('Agent History is missing its existing header controls.')
  }
  if (!state.placeholders.includes('Search sessions, repo:, path:')) {
    throw new Error('Agent History is missing its existing search input.')
  }
  await evidenceStep('filter Agent History to parity fixture', () =>
    setHostedWebViewInput(activeHistoryDocument, {
      placeholder: 'Search sessions, repo:, path:',
      value: EMULATOR_AGENT_HISTORY_TITLE
    })
  )
  activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_TITLE,
    timeoutMs
  })
  const hostedAgentHistory = await captureHostedAgentHistoryParity({
    document: activeHistoryDocument,
    deviceUdid: emulator.deviceUdid,
    emulator,
    nativeBaseline: nativeAgentHistory,
    runtimeDirectory,
    timeoutMs
  })
  await evidenceStep('expand Agent History row', () =>
    activateHostedWebViewControl(activeHistoryDocument, {
      kind: 'text',
      value: EMULATOR_AGENT_HISTORY_TITLE
    })
  )
  activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_PREVIEW_MARKER,
    timeoutMs
  })
  await evidenceStep('filter Agent History', () =>
    setHostedWebViewInput(activeHistoryDocument, {
      placeholder: 'Search sessions, repo:, path:',
      value: 'NO_MATCHING_AGENT_HISTORY_SESSION'
    })
  )
  activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: 'No sessions match your search.',
    timeoutMs
  })
  await evidenceStep('clear Agent History filter', () =>
    setHostedWebViewInput(activeHistoryDocument, {
      placeholder: 'Search sessions, repo:, path:',
      value: ''
    })
  )
  activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_TITLE,
    timeoutMs
  })
  const reconnect = await evidenceStep('retain Agent History through reconnect', async () => {
    await startHostedWebViewConnectionObservation(activeHistoryDocument, {
      expectedText: EMULATOR_AGENT_HISTORY_TITLE,
      expectedHrefIncludes: '/agent-history/'
    })
    if (!launcher.kill('SIGUSR2')) {
      throw new Error('Temporary desktop runtime restart signal was not delivered')
    }
    const connectionEntries = await waitForHostedWebViewConnectionSequence(
      activeHistoryDocument,
      ['recovering', 'connected'],
      timeoutMs,
      {
        reacquireDocument: (remainingMs) =>
          waitForVisibleHostedWebView({
            discoveryUrl,
            expectedText: EMULATOR_AGENT_HISTORY_TITLE,
            expectedHrefIncludes: '/agent-history/',
            requireInteractiveControls: false,
            timeoutMs: remainingMs
          })
      }
    )
    const recoveringEntry = connectionEntries.find((entry) => entry.state === 'recovering')
    if (!recoveringEntry?.retainedExpectedText || !recoveringEntry.retainedExpectedRoute) {
      throw new Error('Agent History was not retained while the secure connection recovered')
    }
    return {
      retainedRoute: recoveringEntry.href,
      states: connectionEntries.map((entry) => entry.state),
      recovered: true
    }
  })
  activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_TITLE,
    expectedHrefIncludes: '/agent-history/',
    timeoutMs
  })
  await delay(500)
  await evidenceStep('select Project scope', () =>
    activateHostedWebViewControl(activeHistoryDocument, {
      kind: 'text',
      value: 'Project'
    })
  )
  activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_TITLE,
    timeoutMs
  })
  await evidenceStep('select All scope', () =>
    activateHostedWebViewControl(activeHistoryDocument, {
      kind: 'text',
      value: 'All'
    })
  )
  activeHistoryDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_TITLE,
    timeoutMs
  })
  const nativeResumePoint = await evidenceStep('resume Agent History from native touch', () =>
    tapHostedIosAccessibilityControl(emulator, 'Resume agent session', timeoutMs)
  )
  const resumedSessionDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: '2 tabs',
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  const resumedActionsDocument = await evidenceStep('open resumed Session actions', async () => {
    await activateHostedWebViewControl(resumedSessionDocument, {
      kind: 'label',
      value: 'More session actions'
    })
    return waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: 'Agent History',
      expectedHrefIncludes: '/session/',
      timeoutMs
    })
  })
  await delay(500)
  const resumedHistoryDocument = await evidenceStep('reopen Agent History', async () => {
    await activateHostedWebViewControl(resumedActionsDocument, {
      kind: 'text',
      value: 'Agent History'
    })
    return waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: 'Agent Session History',
      expectedHrefIncludes: '/agent-history/',
      timeoutMs
    })
  })
  await evidenceStep('return from Agent History', () =>
    activateHostedWebViewControl(resumedHistoryDocument, {
      kind: 'label',
      value: 'Back'
    })
  )
  const returnedSessionDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: '2 tabs',
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  return {
    route: state.href,
    scopes: ['Workspace', 'Project', 'All'],
    search: 'present',
    row: EMULATOR_AGENT_HISTORY_TITLE,
    preview: EMULATOR_AGENT_HISTORY_PREVIEW_MARKER,
    parityFixture: {
      portrait: agentHistoryParityEvidence(
        nativeAgentHistory.portrait,
        hostedAgentHistory.portrait
      ),
      landscape: agentHistoryParityEvidence(
        nativeAgentHistory.landscape,
        hostedAgentHistory.landscape
      )
    },
    reconnect,
    resume: {
      native: 'queued',
      nativeTouchPoint: nativeResumePoint,
      resumedRoute: resumedSessionDocument.href
    },
    backRoute: returnedSessionDocument.href,
    headerControls: ['Back', 'Refresh agent sessions']
  }
}

async function evidenceStep(label, run) {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
