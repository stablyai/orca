import { WebSocket } from 'ws'
import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

export async function readHostedWebViewControlPoint(document, label, WebSocketCtor = WebSocket) {
  const expression = `(() => {
    const element = Array.from(document.querySelectorAll('[aria-label]'))
      .find((candidate) => candidate.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!(element instanceof HTMLElement)) return '';
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const screenWidth = Number(screen.width);
    const screenHeight = Number(screen.height);
    const viewportTop = Math.max(0, screenHeight - Number(innerHeight));
    return JSON.stringify({
      x: (rect.left + rect.width / 2) / screenWidth,
      y: (viewportTop + rect.top + rect.height / 2) / screenHeight
    });
  })()`
  const value = await evaluateHostedDocumentWithRetry(document, expression, WebSocketCtor)
  let point
  try {
    point = JSON.parse(value)
  } catch {
    throw new Error(`Hosted WebView control was not measurable: ${label}`)
  }
  if (!isNormalizedPoint(point)) {
    throw new Error(`Hosted WebView returned an invalid control point: ${label}`)
  }
  return point
}

function isNormalizedPoint(point) {
  return (
    point &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  )
}
