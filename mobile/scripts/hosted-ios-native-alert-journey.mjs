import { randomBytes } from 'node:crypto'
import {
  tapHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityLabel,
  waitForHostedIosAccessibilityLabelToDisappear
} from './hosted-ios-emulator-accessibility.mjs'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

const ALERT_PROBE_PROPERTY = '__orcaE2eNativeAlertProbe'
const ALERT_TITLE = 'Hosted native Alert probe'

export async function verifyHostedIosNativeAlertJourney(
  { discoveryUrl, emulator, expectedWorkspace, timeoutMs, workspaceDocument },
  operations = {}
) {
  const evaluate = operations.evaluate ?? evaluateHostedDocumentWithRetry
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const activateWorkspace = operations.activateWorkspace ?? activateHostedWorkspaceRow
  const activateControl = operations.activateControl ?? activateHostedWebViewControl
  const waitForLabel = operations.waitForLabel ?? waitForHostedIosAccessibilityLabel
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const waitForLabelToDisappear =
    operations.waitForLabelToDisappear ?? waitForHostedIosAccessibilityLabelToDisappear

  await installNativeAlertProbe(workspaceDocument, evaluate)
  await activateWorkspace(workspaceDocument, expectedWorkspace, activateControl, timeoutMs, () =>
    waitForWorkspaceDocument(discoveryUrl, expectedWorkspace, timeoutMs, waitForDocument)
  )
  const sessionDocument = await waitForDocument({
    discoveryUrl,
    expectedText: 'Mobile Emulator',
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  const requestId = randomBytes(16).toString('base64url')
  await postNativeAlertProbe(sessionDocument, requestId, evaluate)
  const title = await waitForLabel(emulator, ALERT_TITLE, timeoutMs)
  const button = await tapControl(emulator, 'Keep editing', timeoutMs)
  await waitForLabelToDisappear(emulator, ALERT_TITLE, timeoutMs)
  const response = await waitForNativeAlertResponse(sessionDocument, requestId, timeoutMs, evaluate)
  if (response?.status !== 'success' || response.payload?.buttonIndex !== 0) {
    throw new Error(`Native Alert returned an invalid response: ${JSON.stringify(response)}`)
  }
  await activateControl(sessionDocument, { kind: 'label', value: 'Back to worktrees' })
  const returnedWorkspaceDocument = await waitForWorkspaceDocument(
    discoveryUrl,
    expectedWorkspace,
    timeoutMs,
    waitForDocument
  )
  return {
    evidence: {
      button,
      buttonIndex: response.payload.buttonIndex,
      presentation: 'native',
      title: title.frame
    },
    workspaceDocument: returnedWorkspaceDocument
  }
}

async function installNativeAlertProbe(document, evaluate) {
  const expression = `(() => {
    const key = ${JSON.stringify(ALERT_PROBE_PROPERTY)};
    if (globalThis[key]) return JSON.stringify({ started: true });
    const native = globalThis.OrcaNative;
    if (!native || typeof native.postMessage !== 'function') {
      return JSON.stringify({ started: false });
    }
    const state = globalThis[key] = { context: null, responses: Object.create(null) };
    addEventListener('message', (event) => {
      try {
        const message = typeof event.data === 'string' ? JSON.parse(event.data) : null;
        if (message?.type === 'response' && typeof message.requestId === 'string') {
          state.responses[message.requestId] = message;
        }
      } catch {}
    });
    globalThis.OrcaNative = Object.freeze({
      postMessage(value) {
        try {
          const message = JSON.parse(value);
          if (message?.shellSessionId && message?.buildId && Number.isInteger(message.version)) {
            state.context = {
              version: message.version,
              shellSessionId: message.shellSessionId,
              buildId: message.buildId
            };
          }
        } catch {}
        native.postMessage(value);
      }
    });
    return JSON.stringify({ started: true });
  })()`
  const result = JSON.parse(await evaluate(document, expression))
  if (result?.started !== true) {
    throw new Error('Native Alert probe could not observe the hosted bridge')
  }
}

async function postNativeAlertProbe(document, requestId, evaluate) {
  const expression = `(() => {
    const state = globalThis[${JSON.stringify(ALERT_PROBE_PROPERTY)}];
    if (!state?.context) return JSON.stringify({ posted: false });
    globalThis.OrcaNative.postMessage(JSON.stringify({
      ...state.context,
      type: 'request',
      mode: 'once',
      requestId: ${JSON.stringify(requestId)},
      capability: 'native',
      operation: 'alert',
      payload: {
        title: ${JSON.stringify(ALERT_TITLE)},
        message: 'The hosted page requested this operating-system dialog.',
        buttons: [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive' }
        ],
        options: { cancelable: false }
      }
    }));
    return JSON.stringify({ posted: true });
  })()`
  const result = JSON.parse(await evaluate(document, expression))
  if (result?.posted !== true) {
    throw new Error('Native Alert probe did not capture an active bridge context')
  }
}

async function waitForNativeAlertResponse(document, requestId, timeoutMs, evaluate) {
  const deadline = Date.now() + timeoutMs
  const expression = `JSON.stringify(globalThis[${JSON.stringify(
    ALERT_PROBE_PROPERTY
  )}]?.responses?.[${JSON.stringify(requestId)}] ?? null)`
  while (Date.now() < deadline) {
    const result = JSON.parse(await evaluate(document, expression))
    if (result) {
      return result
    }
    await delay(100)
  }
  throw new Error('Native Alert response did not return to the hosted page')
}

function waitForWorkspaceDocument(discoveryUrl, expectedWorkspace, timeoutMs, waitForDocument) {
  return waitForDocument({ discoveryUrl, expectedText: expectedWorkspace, timeoutMs })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
