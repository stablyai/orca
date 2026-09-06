import { WebSocket } from 'ws'
import { evaluateHostedWebViewCdp } from './hosted-webview-cdp-evaluation.mjs'
import {
  assertNoHostedMobileWebCdpTarget,
  CDP_TARGET_LIMIT,
  HOSTED_DOCUMENT_TEXT_LIMIT,
  isHostedMobileWebUrl,
  probeHostedWebView,
  readCdpTargets
} from './hosted-webview-cdp-target-discovery.mjs'

const CDP_MESSAGE_MAX_BYTES = 2 * 1024 * 1024
const HOSTED_CONTROL_ACTIVATION_ATTRIBUTE = 'data-orca-cdp-activation'
const HOSTED_CONNECTION_OBSERVATION_PROPERTY = '__orcaE2eConnectionObservation'
let hostedControlActivationSequence = 0

export { assertNoHostedMobileWebCdpTarget, isHostedMobileWebUrl }

export function selectVisibleHostedWebView(
  probes,
  expectedText,
  expectedHrefIncludes,
  requireInteractiveControls = true
) {
  const eligible = probes.filter(
    (probe) =>
      isHostedMobileWebUrl(probe.href) &&
      (!expectedHrefIncludes || probe.href.includes(expectedHrefIncludes)) &&
      probe.visibility === 'visible' &&
      probe.bridgeListening &&
      probe.bodyText.includes(expectedText) &&
      (!requireInteractiveControls || probe.buttonCount > 0)
  )
  return eligible.find((probe) => probe.focused) ?? eligible[0] ?? null
}

export async function waitForVisibleHostedWebView({
  discoveryUrl,
  expectedText,
  expectedHrefIncludes,
  requireInteractiveControls = true,
  timeoutMs,
  fetchImpl = fetch,
  WebSocketCtor = WebSocket
}) {
  const deadline = Date.now() + timeoutMs
  let lastSummary = 'No inspectable WebKit targets'
  while (Date.now() < deadline) {
    try {
      const targets = await readCdpTargets(discoveryUrl, fetchImpl)
      const probes = (
        await Promise.all(
          targets
            .slice(-CDP_TARGET_LIMIT)
            .map((target) => probeHostedWebView(target, WebSocketCtor))
        )
      ).filter(Boolean)
      lastSummary = JSON.stringify(
        probes.map(({ href, visibility, focused, bridgeListening, bodyText, buttonCount }) => ({
          href,
          visibility,
          focused,
          bridgeListening,
          buttonCount,
          textLength: bodyText.length,
          textPreview: bodyText.slice(0, 240)
        }))
      )
      const selected = selectVisibleHostedWebView(
        probes,
        expectedText,
        expectedHrefIncludes,
        requireInteractiveControls
      )
      if (selected) {
        return selected
      }
    } catch (error) {
      lastSummary = error instanceof Error ? error.message : String(error)
    }
    await delay(500)
  }
  throw new Error(
    `Timed out waiting for the visible hosted mobile document. Last targets: ${lastSummary}`
  )
}

export async function verifyHostedWebViewNetworkIsolation({
  document,
  probeId,
  settleDelayMs = 250,
  WebSocketCtor = WebSocket
}) {
  if (!document?.webSocketDebuggerUrl) {
    throw new Error('Hosted WebView inspector target is unavailable')
  }
  if (typeof probeId !== 'string' || probeId.length === 0) {
    throw new Error('Hosted WebView network probe token is unavailable')
  }
  const started = await evaluateHostedDocumentWithRetry(
    document,
    `(() => {
      const run = globalThis.__orcaRunSecurityProbe;
      if (typeof run !== 'function') return '';
      run();
      return ${JSON.stringify(probeId)};
    })()`,
    WebSocketCtor
  )
  if (started !== probeId) {
    throw new Error('Hosted WebView network probe could not start')
  }
  await delay(settleDelayMs)
  const completed = await evaluateHostedDocumentWithRetry(
    document,
    `String(globalThis.__orcaDebugNetworkProbeCompletion ?? '')`,
    WebSocketCtor
  )
  if (completed !== probeId) {
    throw new Error('Hosted WebView network probe did not complete')
  }
  return {
    fetch: 'attempted',
    xhr: 'attempted',
    webSocket: 'attempted',
    image: 'attempted'
  }
}

export async function verifyHostedWebViewNavigationIsolation({
  document,
  discoveryUrl,
  probeId,
  settleDelayMs = 500,
  WebSocketCtor = WebSocket,
  fetchImpl = fetch
}) {
  if (!document?.webSocketDebuggerUrl) {
    throw new Error('Hosted WebView inspector target is unavailable')
  }
  if (typeof probeId !== 'string' || probeId.length === 0) {
    throw new Error('Hosted WebView navigation probe token is unavailable')
  }
  await delay(settleDelayMs)
  const value = await evaluateHostedDocumentWithRetry(
    document,
    `String(globalThis.__orcaDebugNavigationProbeCompletion ?? '')`,
    WebSocketCtor
  )
  let result
  try {
    result = JSON.parse(value)
  } catch {
    throw new Error('Hosted WebView navigation probe did not complete')
  }
  const popupBlocked =
    result.popupBlocked === true ||
    (discoveryUrl ? await verifyNoPopupInspectorTarget(document, discoveryUrl, fetchImpl) : false)
  const expected = {
    token: probeId,
    documentRetained: true,
    popupBlocked: true,
    serviceWorkerBlocked: true,
    redirectFrameAttempted: true,
    downloadAttempted: true,
    externalSchemeAttempted: true
  }
  const verifiedResult = { ...result, popupBlocked }
  if (JSON.stringify(verifiedResult) !== JSON.stringify(expected)) {
    throw new Error(`Hosted WebView navigation isolation failed: ${JSON.stringify(result)}`)
  }
  const { token: _, ...evidence } = verifiedResult
  return evidence
}

async function verifyNoPopupInspectorTarget(document, discoveryUrl, fetchImpl) {
  const targets = await readCdpTargets(discoveryUrl, fetchImpl)
  const pages = targets.filter((target) => target.type === 'page')
  return pages.length === 1 && pages[0]?.id === document.targetId
}

export async function readHostedWebViewState(document, WebSocketCtor = WebSocket) {
  const expression = `JSON.stringify({
    href: String(location.href).slice(0, 2048),
    bodyText: String(document.body?.innerText ?? '').slice(0, ${HOSTED_DOCUMENT_TEXT_LIMIT}),
    labels: Array.from(document.querySelectorAll('[aria-label]')).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth;
    }).slice(0, 128)
      .map((element) => String(element.getAttribute('aria-label') ?? '').slice(0, 240)),
    placeholders: Array.from(document.querySelectorAll('input[placeholder],textarea[placeholder]'))
      .slice(0, 32)
      .map((element) => String(element.getAttribute('placeholder') ?? '').slice(0, 240))
  })`
  const value = await evaluateHostedDocumentWithRetry(document, expression, WebSocketCtor)
  const parsed = JSON.parse(value)
  if (
    typeof parsed?.href !== 'string' ||
    typeof parsed.bodyText !== 'string' ||
    !Array.isArray(parsed.labels) ||
    !parsed.labels.every((label) => typeof label === 'string') ||
    !Array.isArray(parsed.placeholders) ||
    !parsed.placeholders.every((placeholder) => typeof placeholder === 'string')
  ) {
    throw new Error('Hosted WebView state probe returned an invalid value')
  }
  return parsed
}

export async function readHostedWebViewTextPoint(
  document,
  text,
  WebSocketCtor = WebSocket,
  options = {}
) {
  const horizontalPosition = options.horizontalPosition ?? 0.5
  if (!Number.isFinite(horizontalPosition) || horizontalPosition < 0 || horizontalPosition > 1) {
    throw new Error('Hosted WebView text point position is invalid')
  }
  const expression = `(() => {
    const expected = ${JSON.stringify(text)};
    const comparableExpected = ${
      options.ignoreCase === true
    } ? expected.toLocaleLowerCase() : expected;
    const isVisible = (candidate) => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth;
    };
    const matches = Array.from(document.querySelectorAll('body *')).filter((candidate) =>
      candidate.children.length === 0 && (${options.reveal === true} || isVisible(candidate)) && (
        ${
          options.ignoreCase === true
            ? "String(candidate.textContent ?? '').trim().toLocaleLowerCase()"
            : "String(candidate.textContent ?? '').trim()"
        }
      ) === comparableExpected
    );
    const element = matches[${options.occurrence ?? 0}];
    if (!element) return '';
    if (${options.reveal === true}) {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    const rect = element.getBoundingClientRect();
    const screenWidth = Number(screen.width);
    const screenHeight = Number(screen.height);
    const viewportTop = Math.max(0, screenHeight - Number(innerHeight));
    return JSON.stringify({
      x: (rect.left + rect.width * ${horizontalPosition}) / screenWidth,
      y: (viewportTop + rect.top + rect.height / 2) / screenHeight
    });
  })()`
  const value = await evaluateHostedDocumentWithRetry(document, expression, WebSocketCtor)
  let point
  try {
    point = JSON.parse(value)
  } catch {
    throw new Error(`Hosted WebView control was not found: ${text}`)
  }
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  ) {
    throw new Error(`Hosted WebView returned an invalid text point: ${text}`)
  }
  return point
}

export function terminateHostedWebViewProcess(document, WebSocketCtor = WebSocket) {
  if (!document?.webSocketDebuggerUrl) {
    return Promise.reject(new Error('Hosted WebView inspector target is unavailable'))
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(document.webSocketDebuggerUrl, {
      maxPayload: CDP_MESSAGE_MAX_BYTES
    })
    const timer = setTimeout(
      () => finish(new Error('Hosted WebView process termination timed out')),
      5_000
    )
    let settled = false

    const finish = (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    socket.once('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Page.crash' }))
    })
    socket.on('message', (data) => {
      try {
        if (data.length > CDP_MESSAGE_MAX_BYTES) {
          finish(new Error('WebKit CDP response exceeded its size limit'))
          return
        }
        const message = JSON.parse(String(data))
        if (
          message.method === 'Inspector.detached' &&
          message.params?.reason === 'Render process gone.'
        ) {
          finish()
        } else if (message.id === 1 && message.error) {
          finish(new Error(message.error.message ?? 'WebKit process termination failed'))
        }
      } catch (error) {
        finish(error)
      }
    })
    socket.once('error', (error) => finish(error))
    socket.once('close', () => {
      if (!settled) {
        finish(new Error('WebKit process closed without termination evidence'))
      }
    })
  })
}

export async function startHostedWebViewConnectionObservation(
  document,
  { expectedText, expectedHrefIncludes },
  WebSocketCtor = WebSocket
) {
  const expression = `(() => {
    const key = ${JSON.stringify(HOSTED_CONNECTION_OBSERVATION_PROPERTY)};
    const observation = globalThis[key] ??= { entries: [], listening: false };
    observation.entries.length = 0;
    observation.expectedText = ${JSON.stringify(expectedText)};
    observation.expectedHrefIncludes = ${JSON.stringify(expectedHrefIncludes)};
    if (!observation.listening) {
      addEventListener('message', (event) => {
        try {
          const message = typeof event.data === 'string' ? JSON.parse(event.data) : null;
          if (message?.type !== 'connection') return;
          const state = message.state;
          if (!['connecting', 'connected', 'offline', 'recovering'].includes(state)) return;
          requestAnimationFrame(() => {
            const current = globalThis[key];
            if (!current) return;
            const href = String(location.href).slice(0, 2048);
            current.entries.push({
              state,
              href,
              retainedExpectedText: String(document.body?.innerText ?? '')
                .includes(current.expectedText),
              retainedExpectedRoute: href.includes(current.expectedHrefIncludes)
            });
            if (current.entries.length > 32) current.entries.shift();
          });
        } catch {}
      });
      observation.listening = true;
    }
    return JSON.stringify({ started: true });
  })()`
  const value = await evaluateHostedDocumentWithRetry(document, expression, WebSocketCtor)
  if (JSON.parse(value)?.started !== true) {
    throw new Error('Hosted WebView connection observation did not start')
  }
}

export async function waitForHostedWebViewConnectionSequence(
  document,
  expectedStates,
  timeoutMs,
  transport = WebSocket
) {
  const WebSocketCtor =
    typeof transport === 'function' ? transport : (transport.WebSocketCtor ?? WebSocket)
  const reacquireDocument =
    typeof transport === 'function' ? undefined : transport.reacquireDocument
  const deadline = Date.now() + timeoutMs
  let entries = []
  let activeDocument = document
  const observedEntryCounts = new Map()
  const expression = `JSON.stringify(globalThis[${JSON.stringify(
    HOSTED_CONNECTION_OBSERVATION_PROPERTY
  )}]?.entries ?? [])`
  while (Date.now() < deadline) {
    let currentEntries
    try {
      const value = await evaluateHostedDocumentWithRetry(activeDocument, expression, WebSocketCtor)
      currentEntries = JSON.parse(value)
    } catch (error) {
      if (!reacquireDocument) {
        throw error
      }
      activeDocument = await reacquireDocument(Math.max(1, deadline - Date.now()))
      continue
    }
    const documentKey = activeDocument.webSocketDebuggerUrl
    const previousCount = observedEntryCounts.get(documentKey) ?? 0
    const nextOffset = currentEntries.length < previousCount ? 0 : previousCount
    entries.push(...currentEntries.slice(nextOffset))
    observedEntryCounts.set(documentKey, currentEntries.length)
    if (hasOrderedConnectionStates(entries, expectedStates)) {
      return entries
    }
    await delay(250)
  }
  throw new Error(
    `Hosted WebView did not observe connection sequence ${expectedStates.join(
      ' → '
    )}. Last states: ${entries.map((entry) => entry.state).join(', ')}`
  )
}

function hasOrderedConnectionStates(entries, expectedStates) {
  let expectedIndex = 0
  for (const entry of entries) {
    if (entry?.state === expectedStates[expectedIndex]) {
      expectedIndex += 1
    }
  }
  return expectedIndex === expectedStates.length
}

export async function evaluateHostedDocumentWithRetry(
  document,
  expression,
  WebSocketCtor = WebSocket
) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await evaluateHostedDocument(document, expression, WebSocketCtor)
    } catch (error) {
      lastError = error
      await delay(250)
    }
  }
  throw lastError
}

export async function activateHostedWebViewControl(document, target, WebSocketCtor = WebSocket) {
  const activationToken = `activation-${Date.now()}-${hostedControlActivationSequence++}`
  const locateExpression = `(() => {
    const expected = ${JSON.stringify(target.value)};
    const comparableExpected = ${
      target.ignoreCase === true
    } ? expected.toLocaleLowerCase() : expected;
    const token = ${JSON.stringify(activationToken)};
    const isVisible = (candidate) => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth;
    };
    const candidates = Array.from(document.querySelectorAll(${
      target.kind === 'label' ? "'[aria-label]'" : "'body *'"
    }));
    const matches = candidates.filter((candidate) => (${
      target.reveal === true
    } || isVisible(candidate)) && ${
      target.kind === 'label'
        ? "candidate.getAttribute('aria-label') === expected"
        : `candidate.children.length === 0 && (
          ${
            target.ignoreCase === true
              ? "String(candidate.textContent ?? '').trim().toLocaleLowerCase()"
              : "String(candidate.textContent ?? '').trim()"
          }
        ) === comparableExpected`
    });
    const interactive = ${
      target.kind === 'label'
        ? 'matches'
        : 'Array.from(new Set(matches.map((candidate) => candidate.closest(\'button,[role="button"],a,[tabindex]\')).filter(Boolean)))'
    };
    const controls = interactive.length > 0 ? interactive : matches;
    const element = controls[${target.occurrence ?? 0}];
    if (!(element instanceof HTMLElement)) return JSON.stringify({ found: false });
    if (${target.reveal === true}) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    element.setAttribute(${JSON.stringify(HOSTED_CONTROL_ACTIVATION_ATTRIBUTE)}, token);
    return JSON.stringify({ found: true });
  })()`
  const locatedValue = await evaluateHostedDocumentWithRetry(
    document,
    locateExpression,
    WebSocketCtor
  )
  const located = JSON.parse(locatedValue)
  if (located?.found !== true) {
    throw new Error(`Hosted WebView control was not found: ${target.value}`)
  }

  const activateExpression = `(() => {
    const token = ${JSON.stringify(activationToken)};
    const ledger = globalThis.__orcaCdpActivationLedger ??= new Set();
    if (ledger.has(token)) return JSON.stringify({ activated: true, duplicate: true });
    const element = Array.from(document.querySelectorAll('[${HOSTED_CONTROL_ACTIVATION_ATTRIBUTE}]'))
      .find((candidate) => candidate.getAttribute(${JSON.stringify(
        HOSTED_CONTROL_ACTIVATION_ATTRIBUTE
      )}) === token);
    if (!(element instanceof HTMLElement)) return JSON.stringify({ activated: false });
    ledger.add(token);
    element.click();
    return JSON.stringify({ activated: true });
  })()`
  const value = await evaluateHostedDocumentWithRetry(document, activateExpression, WebSocketCtor)
  const parsed = JSON.parse(value)
  if (parsed?.activated !== true) {
    throw new Error(`Hosted WebView control was not found: ${target.value}`)
  }
}

export async function setHostedWebViewInput(document, target, WebSocketCtor = WebSocket) {
  const expression = `(() => {
    const input = Array.from(document.querySelectorAll('input[placeholder],textarea[placeholder]'))
      .find((candidate) => candidate.getAttribute('placeholder') === ${JSON.stringify(
        target.placeholder
      )});
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
      return JSON.stringify({ updated: false });
    }
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return JSON.stringify({ updated: false });
    setter.call(input, ${JSON.stringify(target.value)});
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: null
    }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ updated: true });
  })()`
  const value = await evaluateHostedDocumentWithRetry(document, expression, WebSocketCtor)
  const parsed = JSON.parse(value)
  if (parsed?.updated !== true) {
    throw new Error(`Hosted WebView input was not found: ${target.placeholder}`)
  }
}

function evaluateHostedDocument(document, expression, WebSocketCtor) {
  if (!document?.webSocketDebuggerUrl) {
    throw new Error('Hosted WebView inspector target is unavailable')
  }
  return evaluateHostedWebViewCdp(document.webSocketDebuggerUrl, expression, WebSocketCtor)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
