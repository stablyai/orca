import { WebSocket } from 'ws'
import {
  HOSTED_ADVERSARIAL_HTML_FILENAME,
  HOSTED_ADVERSARIAL_HTML_MARKER,
  HOSTED_ADVERSARIAL_IMAGE_FILENAME,
  HOSTED_ADVERSARIAL_IMAGE_MARKER,
  HOSTED_ADVERSARIAL_MARKDOWN_FILENAME,
  HOSTED_ADVERSARIAL_MARKDOWN_MARKER,
  HOSTED_ADVERSARIAL_SVG_FILENAME,
  HOSTED_ADVERSARIAL_SVG_MARKER
} from './hosted-adversarial-repository-fixture.mjs'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  readHostedWebViewState
} from './hosted-webview-cdp-session.mjs'
import { navigateHostedWebViewRoute } from './hosted-webview-route-navigation.mjs'

const executionExpression = `JSON.stringify({
  markers: [
    Boolean(globalThis.${HOSTED_ADVERSARIAL_MARKDOWN_MARKER}),
    Boolean(globalThis.${HOSTED_ADVERSARIAL_HTML_MARKER}),
    Boolean(globalThis.${HOSTED_ADVERSARIAL_SVG_MARKER}),
    Boolean(globalThis.${HOSTED_ADVERSARIAL_IMAGE_MARKER})
  ],
  injectedElementCount: document.querySelectorAll('[data-orca-adversarial]').length
})`

export async function inspectHostedWebViewAdversarialFiles({
  document,
  fixture,
  timeoutMs,
  WebSocketCtor = WebSocket
}) {
  const reviewRoute = routeFromDocument(document, 'review')
  await activateHostedWebViewControl(document, { kind: 'label', value: 'Back' }, WebSocketCtor)
  await waitForRoute(document, '/session/', 'tabs', timeoutMs, WebSocketCtor)
  await waitForLabel(document, 'Open file explorer', timeoutMs, WebSocketCtor)
  await activateHostedWebViewControl(
    document,
    { kind: 'label', value: 'Open file explorer' },
    WebSocketCtor
  )
  await waitForRoute(document, '/files/', 'Files', timeoutMs, WebSocketCtor)

  const markdown = fileFixture(fixture, HOSTED_ADVERSARIAL_MARKDOWN_FILENAME)
  await openPreview(document, markdown.filename, timeoutMs, WebSocketCtor)
  await waitForText(document, markdown.marker, timeoutMs, WebSocketCtor)
  await assertNoAdversarialExecution(document, WebSocketCtor)
  await activateHostedWebViewControl(
    document,
    { kind: 'label', value: 'View Markdown source' },
    WebSocketCtor
  )
  await waitForText(document, markdown.content.trim(), timeoutMs, WebSocketCtor)
  await assertNoAdversarialExecution(document, WebSocketCtor)
  await returnToFiles(document, timeoutMs, WebSocketCtor)

  const html = fileFixture(fixture, HOSTED_ADVERSARIAL_HTML_FILENAME)
  await openPreview(document, html.filename, timeoutMs, WebSocketCtor)
  await waitForText(document, html.content.trim(), timeoutMs, WebSocketCtor)
  await assertNoAdversarialExecution(document, WebSocketCtor)
  await returnToFiles(document, timeoutMs, WebSocketCtor)

  const svg = fileFixture(fixture, HOSTED_ADVERSARIAL_SVG_FILENAME)
  await openPreview(document, svg.filename, timeoutMs, WebSocketCtor)
  await waitForText(document, svg.content.trim(), timeoutMs, WebSocketCtor)
  await assertNoAdversarialExecution(document, WebSocketCtor)
  await returnToFiles(document, timeoutMs, WebSocketCtor)

  const image = fileFixture(fixture, HOSTED_ADVERSARIAL_IMAGE_FILENAME)
  await openPreview(document, image.filename, timeoutMs, WebSocketCtor)
  await waitForAdversarialImage(document, image.filename, timeoutMs, WebSocketCtor)
  await assertNoAdversarialExecution(document, WebSocketCtor)

  await navigateHostedWebViewRoute(document, reviewRoute, WebSocketCtor)
  await waitForRoute(document, '/review/', 'reviewed', timeoutMs, WebSocketCtor)
  return {
    markdownPreviewInert: true,
    markdownSourceRenderedAsText: true,
    htmlSourceRenderedAsText: true,
    svgSourceRenderedAsText: true,
    imageMetadataInert: true,
    imageRendered: true,
    injectedElementCount: 0,
    repositoryFileScriptMarkersExecuted: false
  }
}

async function openPreview(document, filename, timeoutMs, WebSocketCtor) {
  const label = `Preview file ${filename}`
  await waitForLabel(document, label, timeoutMs, WebSocketCtor)
  await activateHostedWebViewControl(
    document,
    { kind: 'label', value: label, reveal: true },
    WebSocketCtor
  )
  await waitForRoute(document, '/files/preview/', filename, timeoutMs, WebSocketCtor)
}

async function returnToFiles(document, timeoutMs, WebSocketCtor) {
  await activateHostedWebViewControl(
    document,
    { kind: 'label', value: 'Back to files' },
    WebSocketCtor
  )
  await waitForRoute(document, '/files/', 'Files', timeoutMs, WebSocketCtor)
}

async function assertNoAdversarialExecution(document, WebSocketCtor) {
  const value = await evaluateHostedDocumentWithRetry(document, executionExpression, WebSocketCtor)
  const result = JSON.parse(value)
  hostedAdversarialFileExecutionEvidence(result)
}

export function hostedAdversarialFileExecutionEvidence(result) {
  if (
    !Array.isArray(result?.markers) ||
    result.markers.length !== 4 ||
    result.markers.some((marker) => marker !== false) ||
    result.injectedElementCount !== 0
  ) {
    throw new Error(`Hosted adversarial repository file executed: ${JSON.stringify(result)}`)
  }
  return {
    injectedElementCount: 0,
    repositoryFileScriptMarkersExecuted: false
  }
}

async function waitForAdversarialImage(document, filename, timeoutMs, WebSocketCtor) {
  const label = `${filename} image`
  const expression = `(() => {
    const root = Array.from(document.querySelectorAll('[aria-label]')).find(
      (candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(label)}
    );
    const image = root?.querySelector('img');
    const background = Array.from(root?.children ?? []).some(
      (candidate) => getComputedStyle(candidate).backgroundImage.includes('data:image/png;base64,')
    );
    return JSON.stringify({
      background,
      complete: image?.complete === true,
      dataSource: String(image?.src ?? '').startsWith('data:image/png;base64,'),
      height: Number(image?.naturalHeight ?? 0),
      width: Number(image?.naturalWidth ?? 0)
    });
  })()`
  const deadline = Date.now() + Math.min(timeoutMs, 15_000)
  let result
  while (Date.now() < deadline) {
    result = JSON.parse(await evaluateHostedDocumentWithRetry(document, expression, WebSocketCtor))
    if (
      result.background === true &&
      result.complete === true &&
      result.dataSource === true &&
      result.height === 1 &&
      result.width === 1
    ) {
      return
    }
    await delay(250)
  }
  throw new Error(`Hosted adversarial image did not render: ${JSON.stringify(result)}`)
}

async function waitForLabel(document, expected, timeoutMs, WebSocketCtor) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = await readHostedWebViewState(document, WebSocketCtor)
    if (state.labels.includes(expected)) {
      return state
    }
    await delay(250)
  }
  throw new Error(`Hosted adversarial file control was not rendered: ${expected}`)
}

async function waitForRoute(document, route, text, timeoutMs, WebSocketCtor) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    state = await readHostedWebViewState(document, WebSocketCtor)
    if (state.href.includes(route) && state.bodyText.includes(text)) {
      return state
    }
    await delay(250)
  }
  throw new Error(
    `Hosted adversarial route did not render ${text}: ${state?.href ?? 'unavailable'}`
  )
}

async function waitForText(document, expected, timeoutMs, WebSocketCtor) {
  const deadline = Date.now() + Math.min(timeoutMs, 15_000)
  let state
  while (Date.now() < deadline) {
    const bodyContains = await evaluateHostedDocumentWithRetry(
      document,
      `String(String(document.body?.innerText ?? '').includes(${JSON.stringify(expected)}))`,
      WebSocketCtor
    )
    if (bodyContains === 'true') {
      return
    }
    state = await readHostedWebViewState(document, WebSocketCtor)
    if (state.labels.includes(expected)) {
      return state
    }
    await delay(250)
  }
  const bodyTail = await evaluateHostedDocumentWithRetry(
    document,
    `String(document.body?.innerText ?? '').slice(-8192)`,
    WebSocketCtor
  )
  throw new Error(
    `Hosted adversarial file text was not rendered: ${expected.slice(
      0,
      120
    )} at ${state?.href ?? 'unavailable'}. Body tail: ${JSON.stringify(bodyTail.slice(-1024))}`
  )
}

function routeFromDocument(document, expectedSegment) {
  const url = new URL(document.href)
  if (!url.pathname.includes(`/${expectedSegment}/`)) {
    throw new Error(`Hosted adversarial ${expectedSegment} route is invalid`)
  }
  return `${url.pathname}${url.search}`
}

function fileFixture(fixture, filename) {
  const file = fixture.repositoryFiles.find((candidate) => candidate.filename === filename)
  if (!file) {
    throw new Error(`Hosted adversarial repository file is missing: ${filename}`)
  }
  return file
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
