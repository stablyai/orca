import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  readHostedWebViewTextPoint,
  setHostedWebViewInput,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import {
  EMULATOR_AGENT_HISTORY_PREVIEW_MARKER,
  EMULATOR_AGENT_HISTORY_TITLE
} from './emulator-agent-history-fixture.mjs'
import { tapHostedAndroidPoint } from './hosted-android-emulator-accessibility.mjs'
import { readStableHostedAndroidWebViewPoint } from './hosted-android-webview-touch-point.mjs'
import { readHostedWebViewControlPoint } from './hosted-webview-control-point.mjs'

const SEARCH_PLACEHOLDER = 'Search sessions, repo:, path:'

export async function verifyHostedAndroidAgentHistoryJourney({
  discoveryUrl,
  emulator,
  sessionDocument,
  timeoutMs
}) {
  let historyDocument = await openHostedAndroidAgentHistory({
    discoveryUrl,
    emulator,
    sessionDocument,
    timeoutMs
  })
  historyDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_TITLE,
    expectedHrefIncludes: '/agent-history/',
    timeoutMs
  })
  const state = await evidenceStep('read Agent History state', () =>
    readHostedWebViewState(historyDocument)
  )
  assertAgentHistoryState(state)
  await evidenceStep('expand Agent History row', () =>
    activateHostedWebViewControl(historyDocument, {
      kind: 'text',
      value: EMULATOR_AGENT_HISTORY_TITLE
    })
  )
  historyDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_PREVIEW_MARKER,
    timeoutMs
  })
  await evidenceStep('filter Agent History', () =>
    setHostedWebViewInput(historyDocument, {
      placeholder: SEARCH_PLACEHOLDER,
      value: 'NO_MATCHING_AGENT_HISTORY_SESSION'
    })
  )
  historyDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: 'No sessions match your search.',
    timeoutMs
  })
  await evidenceStep('clear Agent History filter', () =>
    setHostedWebViewInput(historyDocument, {
      placeholder: SEARCH_PLACEHOLDER,
      value: ''
    })
  )
  historyDocument = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: EMULATOR_AGENT_HISTORY_TITLE,
    timeoutMs
  })
  for (const scope of ['Project', 'All']) {
    await evidenceStep(`select ${scope} scope`, () =>
      activateHostedWebViewControl(historyDocument, {
        kind: 'text',
        value: scope
      })
    )
    historyDocument = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: EMULATOR_AGENT_HISTORY_TITLE,
      timeoutMs
    })
  }
  const nativeTouchPoint = await evidenceStep('resume Agent History from native touch', () =>
    tapAndroidLabel(emulator, historyDocument, 'Resume agent session')
  )
  const resumedSessionDocument = await waitForVisibleHostedWebView({
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
    resume: {
      native: 'queued',
      nativeTouchPoint,
      resumedRoute: resumedSessionDocument.href
    },
    headerControls: ['Back', 'Refresh agent sessions'],
    returnedSessionDocument: resumedSessionDocument
  }
}

export async function openHostedAndroidAgentHistory({
  discoveryUrl,
  emulator,
  sessionDocument,
  timeoutMs
}) {
  if (!sessionDocument.href.includes('/session/')) {
    throw new Error('Agent History journey requires an active Session route.')
  }
  const actionsDocument = await evidenceStep('open Session actions', () =>
    retryAndroidRouteActivation({
      activate: () => tapAndroidLabel(emulator, sessionDocument, 'More session actions'),
      wait: () =>
        waitForVisibleHostedWebView({
          discoveryUrl,
          expectedText: 'Agent History',
          expectedHrefIncludes: '/session/',
          timeoutMs: Math.min(timeoutMs, 3_000)
        })
    })
  )
  return evidenceStep('open Agent History', () =>
    retryAndroidRouteActivation({
      activate: () =>
        tapAndroidText(emulator, actionsDocument, 'Agent History', Math.min(timeoutMs, 5_000)),
      wait: () =>
        waitForVisibleHostedWebView({
          discoveryUrl,
          expectedText: 'Agent Session History',
          expectedHrefIncludes: '/agent-history/',
          timeoutMs: Math.min(timeoutMs, 3_000)
        })
    })
  )
}

async function tapAndroidLabel(emulator, document, label) {
  const point = await readStableHostedAndroidWebViewPoint(() =>
    readHostedWebViewControlPoint(document, label)
  )
  return tapHostedAndroidPoint(emulator, point)
}

async function tapAndroidText(emulator, document, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = new Error(`Hosted Android text was not visible: ${text}`)
  while (Date.now() < deadline) {
    try {
      const point = await readHostedWebViewTextPoint(document, text)
      return await tapHostedAndroidPoint(emulator, point)
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw lastError
}

async function retryAndroidRouteActivation({ activate, wait }) {
  let lastError = new Error('Hosted Android route activation failed')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await activate()
      return await wait()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function assertAgentHistoryState(state) {
  for (const expected of ['Workspace', 'Project', 'All']) {
    if (!state.bodyText.includes(expected)) {
      throw new Error(`Agent History is missing its ${expected} scope.`)
    }
  }
  if (!state.labels.includes('Back') || !state.labels.includes('Refresh agent sessions')) {
    throw new Error('Agent History is missing its existing header controls.')
  }
  if (!state.placeholders.includes(SEARCH_PLACEHOLDER)) {
    throw new Error('Agent History is missing its existing search input.')
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
