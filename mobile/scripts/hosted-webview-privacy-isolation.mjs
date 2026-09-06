import { WebSocket } from 'ws'
import {
  evaluateHostedDocumentWithRetry,
  isHostedMobileWebUrl
} from './hosted-webview-cdp-session.mjs'

const privacyExpression = `(() => {
  const serialize = (value) => {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  };
  const html = String(document.documentElement?.outerHTML ?? '');
  const historyState = serialize(history.state);
  const markers = [
    'devicetoken',
    'publickeyb64',
    'hostidentity',
    'credential-secret',
    'orca:web-host-token:',
    'orca.host-token.',
    'openhostlogicalclient',
    'schedulehostcredentialcleanup',
    'orca_e2e_'
  ];
  const matches = (value) => {
    const lower = value.toLocaleLowerCase();
    return markers.filter((marker) => lower.includes(marker));
  };
  const storageLength = (readStorage) => {
    try {
      return Number(readStorage().length);
    } catch {
      return -1;
    }
  };
  let cookieBytes = -1;
  try {
    cookieBytes = String(document.cookie ?? '').length;
  } catch {}
  return JSON.stringify({
    href: String(location.href).slice(0, 2048),
    htmlBytes: new TextEncoder().encode(html).length,
    domMarkers: matches(html),
    historyMarkers: matches(historyState),
    localStorageEntries: storageLength(() => localStorage),
    sessionStorageEntries: storageLength(() => sessionStorage),
    cookieBytes
  });
})()`

export async function verifyHostedWebViewPrivacyIsolation({ document, WebSocketCtor = WebSocket }) {
  if (!document?.webSocketDebuggerUrl) {
    throw new Error('Hosted WebView inspector target is unavailable')
  }
  const value = await evaluateHostedDocumentWithRetry(document, privacyExpression, WebSocketCtor)
  const result = parsePrivacyResult(value)
  const url = new URL(result.href)
  if (
    !isHostedMobileWebUrl(result.href) ||
    url.username ||
    url.password ||
    url.search ||
    result.domMarkers.length > 0 ||
    result.historyMarkers.length > 0 ||
    result.localStorageEntries > 0 ||
    result.sessionStorageEntries > 0 ||
    result.cookieBytes > 0
  ) {
    throw new Error(`Hosted WebView privacy isolation failed: ${JSON.stringify(result)}`)
  }
  return {
    privateOrigin: true,
    credentialedUrl: false,
    query: false,
    domCredentialMarkers: 0,
    historyCredentialMarkers: 0,
    localStorageEntries: result.localStorageEntries,
    sessionStorageEntries: result.sessionStorageEntries,
    cookieBytes: result.cookieBytes,
    htmlBytes: result.htmlBytes
  }
}

function parsePrivacyResult(value) {
  let result
  try {
    result = JSON.parse(value)
  } catch {
    throw new Error('Hosted WebView privacy probe returned invalid JSON')
  }
  if (
    typeof result?.href !== 'string' ||
    !Number.isSafeInteger(result.htmlBytes) ||
    result.htmlBytes < 0 ||
    !Array.isArray(result.domMarkers) ||
    !result.domMarkers.every((marker) => typeof marker === 'string') ||
    !Array.isArray(result.historyMarkers) ||
    !result.historyMarkers.every((marker) => typeof marker === 'string') ||
    ![result.localStorageEntries, result.sessionStorageEntries, result.cookieBytes].every(
      (count) => Number.isSafeInteger(count) && count >= -1
    )
  ) {
    throw new Error('Hosted WebView privacy probe returned an invalid value')
  }
  return result
}
