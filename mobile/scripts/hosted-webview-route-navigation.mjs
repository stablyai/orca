import { WebSocket } from 'ws'
import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

export async function navigateHostedWebViewRoute(document, route, WebSocketCtor = WebSocket) {
  if (!isSafeHostedRoute(route)) {
    throw new Error('Hosted WebView route is invalid')
  }
  const value = await evaluateHostedDocumentWithRetry(
    document,
    `(() => {
      const route = ${JSON.stringify(route)};
      history.pushState(history.state, '', route);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return String(location.pathname) + String(location.search);
    })()`,
    WebSocketCtor
  )
  const expectedPath = new URL(route, 'https://orca-mobile-web.invalid').pathname
  if (value !== expectedPath) {
    throw new Error('Hosted WebView route navigation was not retained')
  }
}

function isSafeHostedRoute(route) {
  return (
    typeof route === 'string' &&
    route.startsWith('/h/') &&
    !route.startsWith('//') &&
    !route.includes('#')
  )
}
