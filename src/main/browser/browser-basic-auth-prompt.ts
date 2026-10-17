import { randomUUID } from 'node:crypto'

import type {
  BrowserBasicAuthRequest,
  BrowserBasicAuthResponse
} from '../../shared/browser-basic-auth'
import { browserManager } from './browser-manager'

export const BROWSER_BASIC_AUTH_PROMPT_TIMEOUT_MS = 120_000

type PendingBasicAuthRequest = {
  browserPageId: string
  guest: Electron.WebContents
  renderer: Electron.WebContents
  timer: ReturnType<typeof setTimeout>
  onUnavailable: () => void
  settle: (credentials: { username: string; password: string } | null) => void
}

const pendingBasicAuthRequests = new Map<string, PendingBasicAuthRequest>()

function closeRendererPrompt(requestId: string, request: PendingBasicAuthRequest): void {
  try {
    if (!request.renderer.isDestroyed()) {
      request.renderer.send('browser:basic-auth-request-closed', { requestId })
    }
  } catch {
    // The renderer may be destroyed between the check and the send.
  }
}

function cleanUpRequest(requestId: string, request: PendingBasicAuthRequest): void {
  clearTimeout(request.timer)
  request.guest.removeListener('destroyed', request.onUnavailable)
  request.guest.removeListener('render-process-gone', request.onUnavailable)
  request.renderer.removeListener('destroyed', request.onUnavailable)
  request.renderer.removeListener('render-process-gone', request.onUnavailable)
  pendingBasicAuthRequests.delete(requestId)
}

/**
 * Prompt for HTTP basic-auth credentials in the renderer that owns the challenged
 * guest, and hand them to Electron's login callback. Mirrors the WebAuthn account
 * picker: a pending request per challenge, one renderer reply, timeout and
 * guest/renderer teardown cancel with an empty callback (the request then fails
 * with 401, exactly as before this prompt existed).
 */
function requestBrowserBasicAuthCredentials(args: {
  guest: Electron.WebContents
  renderer: Electron.WebContents
  browserPageId: string
  authInfo: { host: string; port: number; realm?: string }
  pageProtocol: string | undefined
  callback: (username?: string, password?: string) => void
}): void {
  const requestId = randomUUID()
  const requestPayload: BrowserBasicAuthRequest = {
    requestId,
    browserPageId: args.browserPageId,
    host: args.authInfo.host,
    port: args.authInfo.port,
    ...(args.pageProtocol ? { protocol: args.pageProtocol } : {}),
    ...(args.authInfo.realm ? { realm: args.authInfo.realm } : {})
  }

  let settled = false
  const settle = (credentials: { username: string; password: string } | null): void => {
    if (settled) {
      return
    }
    settled = true
    const request = pendingBasicAuthRequests.get(requestId)
    if (request) {
      cleanUpRequest(requestId, request)
      closeRendererPrompt(requestId, request)
    }
    if (credentials) {
      args.callback(credentials.username, credentials.password)
    } else {
      args.callback()
    }
  }

  const request: PendingBasicAuthRequest = {
    browserPageId: args.browserPageId,
    guest: args.guest,
    renderer: args.renderer,
    timer: setTimeout(() => settle(null), BROWSER_BASIC_AUTH_PROMPT_TIMEOUT_MS),
    onUnavailable: () => settle(null),
    settle
  }
  pendingBasicAuthRequests.set(requestId, request)
  args.guest.once('destroyed', request.onUnavailable)
  args.guest.once('render-process-gone', request.onUnavailable)
  args.renderer.once('destroyed', request.onUnavailable)
  args.renderer.once('render-process-gone', request.onUnavailable)
  try {
    args.renderer.send('browser:basic-auth-requested', requestPayload)
  } catch {
    settle(null)
  }
}

/**
 * The app-level 'login' handler's non-proxy branch. Server basic-auth challenges
 * previously had no handler at all — the callback was never called, so Electron
 * cancelled the request and the page failed with 401 immediately (#25894).
 */
export function handleBrowserBasicAuthLogin(
  event: { preventDefault(): void },
  guest: Electron.WebContents | null,
  authenticationResponseDetails: { url?: string },
  authInfo: { host: string; port: number; realm?: string },
  callback: (username?: string, password?: string) => void
): void {
  if (!guest || guest.isDestroyed()) {
    return
  }
  const context = browserManager.getRendererContextForGuest(guest.id)
  if (!context || context.renderer.isDestroyed()) {
    return
  }
  event.preventDefault()
  // Why from the response URL and not authInfo.scheme: scheme names the auth
  // method (e.g. "basic"), so it must never label the site; the challenged
  // page's own protocol is what a user expects to read there.
  let pageProtocol: string | undefined
  try {
    const url = new URL(authenticationResponseDetails.url ?? '')
    pageProtocol = url.protocol.replace(/:$/, '') || undefined
  } catch {
    pageProtocol = undefined
  }
  requestBrowserBasicAuthCredentials({
    guest,
    renderer: context.renderer,
    browserPageId: context.browserPageId,
    authInfo,
    pageProtocol,
    callback
  })
}

export function respondToBrowserBasicAuthRequest(
  sender: Electron.WebContents,
  response: BrowserBasicAuthResponse
): boolean {
  if (!response || typeof response.requestId !== 'string') {
    return false
  }
  const request = pendingBasicAuthRequests.get(response.requestId)
  if (!request || request.renderer.id !== sender.id) {
    return false
  }
  if (response.cancelled) {
    request.settle(null)
    return true
  }
  if (typeof response.username !== 'string' || typeof response.password !== 'string') {
    return false
  }
  request.settle({ username: response.username, password: response.password })
  return true
}

export function cancelBrowserBasicAuthRequests(browserPageId: string): void {
  for (const request of pendingBasicAuthRequests.values()) {
    if (request.browserPageId === browserPageId) {
      request.settle(null)
    }
  }
}

export function cancelAllBrowserBasicAuthRequests(): void {
  for (const request of pendingBasicAuthRequests.values()) {
    request.settle(null)
  }
}
