import { WebSocket } from 'ws'
import {
  HOSTED_ADVERSARIAL_CONTENT,
  HOSTED_ADVERSARIAL_CONTENT_MARKER,
  HOSTED_ADVERSARIAL_FILENAME,
  HOSTED_ADVERSARIAL_FILENAME_MARKER
} from './hosted-adversarial-repository-fixture.mjs'
import {
  evaluateHostedDocumentWithRetry,
  readHostedWebViewState
} from './hosted-webview-cdp-session.mjs'

const executionExpression = `JSON.stringify({
  filenameExecuted: Boolean(globalThis.${HOSTED_ADVERSARIAL_FILENAME_MARKER}),
  contentExecuted: Boolean(globalThis.${HOSTED_ADVERSARIAL_CONTENT_MARKER}),
  injectedImageCount: [...document.images].filter((image) => image.getAttribute('src') === 'x').length
})`

export async function verifyHostedWebViewAdversarialContent({
  document,
  documents,
  WebSocketCtor = WebSocket
}) {
  const targets = documents ?? (document ? [document] : [])
  if (targets.length === 0) {
    throw new Error('Hosted adversarial content requires a document')
  }
  const observations = await Promise.all(
    targets.map((target) => readHostedWebViewAdversarialContent(target, WebSocketCtor))
  )
  return hostedWebViewAdversarialContentObservations(observations)
}

export async function readHostedWebViewAdversarialContent(document, WebSocketCtor = WebSocket) {
  const [state, executionValue] = await Promise.all([
    readHostedWebViewState(document, WebSocketCtor),
    evaluateHostedDocumentWithRetry(document, executionExpression, WebSocketCtor)
  ])
  return { state, execution: JSON.parse(executionValue) }
}

export async function captureHostedWebViewAdversarialObservation({
  document,
  expectedMarker,
  timeoutMs,
  WebSocketCtor = WebSocket
}) {
  const deadline = Date.now() + timeoutMs
  let observation
  do {
    observation = await readHostedWebViewAdversarialContent(document, WebSocketCtor)
    const text = `${observation.state.bodyText}\n${observation.state.labels.join('\n')}`
    if (!expectedMarker || text.includes(expectedMarker)) {
      return observation
    }
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error(`Hosted adversarial marker was not rendered: ${expectedMarker}`)
}

export function hostedWebViewAdversarialContentObservations(observations) {
  for (const { execution } of observations) {
    if (
      execution?.filenameExecuted !== false ||
      execution?.contentExecuted !== false ||
      execution?.injectedImageCount !== 0
    ) {
      throw new Error(`Hosted adversarial content executed: ${JSON.stringify(execution)}`)
    }
  }
  return hostedWebViewAdversarialContentEvidence({
    text: observations
      .map(({ state }) => `${state.bodyText}\n${state.labels.join('\n')}`)
      .join('\n'),
    execution: {
      filenameExecuted: false,
      contentExecuted: false,
      injectedImageCount: 0
    }
  })
}

export function hostedWebViewAdversarialContentEvidence({ text, execution }) {
  const filenameRendered = text.includes(HOSTED_ADVERSARIAL_FILENAME)
  const diffRendered = text.includes(HOSTED_ADVERSARIAL_CONTENT)
  if (!filenameRendered || !diffRendered) {
    throw new Error(
      `Hosted adversarial content was not rendered: filename=${filenameRendered} diff=${diffRendered}`
    )
  }
  if (
    execution?.filenameExecuted !== false ||
    execution?.contentExecuted !== false ||
    execution?.injectedImageCount !== 0
  ) {
    throw new Error(`Hosted adversarial content executed: ${JSON.stringify(execution)}`)
  }
  return {
    filenameRenderedAsText: true,
    diffRenderedAsText: true,
    injectedImageCount: 0,
    scriptMarkersExecuted: false
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
