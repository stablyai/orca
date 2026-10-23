import { randomBytes } from 'node:crypto'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import {
  BROWSER_EXTENSION_API_CALL_URL,
  BROWSER_EXTENSION_API_EVENTS_URL,
  decodeBrowserExtensionWireJson,
  encodeBrowserExtensionWireJson
} from '../../../shared/browser-extension-worker-api'
import type { BrowserExtensionCaller } from './browser-extension-namespace-registry'
import {
  ensureWorkerContext,
  type HostSessionState,
  type WorkerContext
} from './browser-extension-contexts'
import {
  attachWorkerEventStream,
  detachWorkerEventStream,
  type WorkerEventStream
} from './browser-extension-worker-event-stream'
import { handleBrowserExtensionApiRequest } from './browser-extension-api-request'

/**
 * Serves the worker shim's fetch calls on each extension session's `orca-extension-api:` handler.
 * The handler's session is the caller's session; the token names the extension. Chromium gives
 * protocol handlers no Origin or Referer, and any page in the session can reach the scheme, so a
 * request without a known token is refused.
 */

const tokenByExtensionId = new Map<string, string>()
const extensionIdByToken = new Map<string, string>()

/** Per app run; written into the extension's Orca-owned folder, where only it can read the file. */
export function getBrowserExtensionWorkerToken(extensionId: string): string {
  let token = tokenByExtensionId.get(extensionId)
  if (!token) {
    token = randomBytes(32).toString('hex')
    tokenByExtensionId.set(extensionId, token)
    extensionIdByToken.set(token, extensionId)
  }
  return token
}

function refuse(status: number): Response {
  return new Response(null, { status })
}

function startTask(worker: Electron.ServiceWorkerMain | null): Electron.StartTask | null {
  try {
    return worker && !worker.isDestroyed() ? worker.startTask() : null
  } catch {
    return null
  }
}

function openEventStream(context: WorkerContext, headers: HeadersInit): Response {
  const encoder = new TextEncoder()
  let stream: WorkerEventStream | null = null
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const opened: WorkerEventStream = {
        send: (payload) =>
          controller.enqueue(encoder.encode(`${encodeBrowserExtensionWireJson(payload)}\n`)),
        close: () => {
          try {
            controller.close()
          } catch {
            // Already closed or cancelled by the worker stopping.
          }
        }
      }
      stream = opened
      attachWorkerEventStream(context, opened)
    },
    // Why: the worker stopping cancels its fetch, which is how main learns events must queue.
    cancel() {
      if (stream) {
        detachWorkerEventStream(context, stream)
      }
    }
  })
  return new Response(body, {
    headers: { ...headers, 'content-type': 'application/x-ndjson' }
  })
}

export async function handleBrowserExtensionWorkerRequest(
  sess: Electron.Session,
  state: HostSessionState,
  request: Request
): Promise<Response> {
  if (request.method !== 'POST') {
    return refuse(405)
  }
  let body: unknown
  try {
    body = decodeBrowserExtensionWireJson(await request.text())
  } catch {
    return refuse(400)
  }
  const token =
    body !== null && typeof body === 'object' && 'token' in body && typeof body.token === 'string'
      ? body.token
      : ''
  const extensionId = extensionIdByToken.get(token)
  const extension = extensionId ? sess.extensions.getExtension(extensionId) : null
  if (!extension) {
    return refuse(403)
  }
  const origin = getChromeExtensionOrigin(extension.id)
  const headers = { 'access-control-allow-origin': origin, 'cache-control': 'no-store' }
  const context = ensureWorkerContext(state, extension.id, `${origin}/`)
  const url = request.url.replace(/\/$/, '')
  if (url === BROWSER_EXTENSION_API_EVENTS_URL) {
    return openEventStream(context, headers)
  }
  if (url !== BROWSER_EXTENSION_API_CALL_URL) {
    return refuse(404)
  }
  const caller: BrowserExtensionCaller = {
    extension,
    session: sess,
    browserProfileId: state.browserProfileId,
    fromWorker: true
  }
  // Why: keep the worker alive only while a call is open, not forever.
  const task = startTask(context.running)
  try {
    const rawRequest =
      body !== null && typeof body === 'object' && 'request' in body ? body.request : null
    const result = await handleBrowserExtensionApiRequest(caller, state, rawRequest, {
      kind: 'worker',
      context
    })
    return new Response(encodeBrowserExtensionWireJson(result), {
      headers: { ...headers, 'content-type': 'application/json' }
    })
  } finally {
    task?.end()
  }
}
