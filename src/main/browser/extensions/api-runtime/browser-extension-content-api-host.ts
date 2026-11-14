import {
  browserExtensionBootstrapAuthority,
  browserExtensionContentAuthority,
  isBrowserExtensionExecutionLive,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'
import {
  extensionHasPermission,
  type BrowserExtensionCaller
} from './browser-extension-namespace-registry'
import { handleBrowserExtensionApiRequest } from './browser-extension-api-request'
import { browserExtensionUntrustedSessionAccess } from '../profile-storage/browser-extension-session-access'
import {
  decodeBrowserExtensionWireJson,
  encodeBrowserExtensionWireJson
} from '../../../../shared/browser/extensions/browser-extension-worker-api'

const METHODS = new Set(['get', 'getKeys', 'getBytesInUse', 'set', 'remove', 'clear'])
const MAX_AUTH_BYTES = 2048
const MAX_BODY_BYTES = 64 * 1024 * 1024
const streams = new WeakMap<
  BrowserExtensionExecution,
  Set<{ context: string; send: (value: Uint8Array) => void }>
>()

function admitted(execution: BrowserExtensionExecution): Electron.Extension | null {
  const extension = execution.session.extensions.getExtension(execution.extensionId)
  return isBrowserExtensionExecutionLive(execution) &&
    extension &&
    extensionHasPermission(extension, 'storage', execution.session)
    ? extension
    : null
}

/** Read authentication first, retaining no unauthenticated payload beyond the reader's current chunk. */
async function framedBody(request: Request): Promise<{
  header: Record<string, unknown>
  body: () => Promise<string | null>
  cancel: () => Promise<void>
} | null> {
  if (!request.body) {
    return null
  }
  const reader = request.body.getReader()
  const auth: Uint8Array[] = []
  let authSize = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) {
      return null
    }
    const newline = chunk.value.indexOf(10)
    const prefix = newline === -1 ? chunk.value : chunk.value.subarray(0, newline)
    authSize += prefix.byteLength
    if (authSize > MAX_AUTH_BYTES) {
      await reader.cancel()
      return null
    }
    auth.push(prefix)
    if (newline === -1) {
      continue
    }
    let header: unknown
    try {
      header = JSON.parse(Buffer.concat(auth).toString('utf8'))
    } catch {
      await reader.cancel()
      return null
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      await reader.cancel()
      return null
    }
    const tail = chunk.value.subarray(newline + 1)
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The authentication header was checked as a non-null non-array object immediately above.
      header: header as Record<string, unknown>,
      cancel: () => reader.cancel(),
      body: async () => {
        let size = tail.byteLength
        if (size > MAX_BODY_BYTES) {
          await reader.cancel()
          return null
        }
        const chunks = [tail]
        for (;;) {
          const next = await reader.read()
          if (next.done) {
            return Buffer.concat(chunks).toString('utf8')
          }
          size += next.value.byteLength
          if (size > MAX_BODY_BYTES) {
            await reader.cancel()
            return null
          }
          chunks.push(next.value)
        }
      }
    }
  }
}

export function emitBrowserExtensionContentSessionChange(
  execution: BrowserExtensionExecution,
  changes: unknown,
  exceptContext?: string
): void {
  if (
    !admitted(execution) ||
    !browserExtensionUntrustedSessionAccess(execution.session, execution.extensionId)
  ) {
    return
  }
  let encoded: Uint8Array | undefined
  for (const stream of streams.get(execution) ?? []) {
    if (stream.context !== exceptContext) {
      encoded ??= new TextEncoder().encode(
        `${encodeBrowserExtensionWireJson({ namespace: 'orcaStorageSession', event: 'onChanged', args: [changes] })}\n`
      )
      stream.send(encoded)
    }
  }
}

export async function handleBrowserExtensionContentRequest(
  session: Electron.Session,
  request: Request
): Promise<Response> {
  const origin = request.headers.get('origin')
  const headers = {
    'access-control-allow-origin': origin ?? '*',
    'cache-control': 'no-store',
    vary: 'origin'
  }
  const refuse = (status: number): Response => new Response(null, { status, headers })
  if (request.method !== 'POST') {
    return refuse(405)
  }
  const route = new URL(request.url).pathname.replace(/\/$/, '')
  const framed = await framedBody(request)
  if (!framed) {
    return refuse(400)
  }
  const { header } = framed
  const execution =
    route === '/mint'
      ? browserExtensionBootstrapAuthority(
          typeof header.bootstrap === 'string' ? header.bootstrap : '',
          session
        )
      : browserExtensionContentAuthority(
          typeof header.token === 'string' ? header.token : '',
          session
        )
  const extension = execution && admitted(execution)
  if (!execution || !extension) {
    await framed.cancel()
    return refuse(403)
  }
  if (route === '/mint') {
    await framed.cancel()
    if (!admitted(execution)) {
      return refuse(403)
    }
    return new Response(encodeBrowserExtensionWireJson({ token: execution.contentToken }), {
      headers
    })
  }
  if (!browserExtensionUntrustedSessionAccess(session, extension.id)) {
    await framed.cancel()
    return refuse(403)
  }
  const context =
    typeof header.context === 'string' && header.context.length <= 128 ? header.context : ''
  if (!context) {
    await framed.cancel()
    return refuse(400)
  }
  if (route === '/events') {
    await framed.cancel()
    if (!admitted(execution) || !browserExtensionUntrustedSessionAccess(session, extension.id)) {
      return refuse(403)
    }
    let close = (): void => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let subscriptions = streams.get(execution)
        if (!subscriptions) {
          subscriptions = new Set()
          streams.set(execution, subscriptions)
        }
        const subscription = {
          context,
          send: (value: Uint8Array) => {
            if (
              !admitted(execution) ||
              !browserExtensionUntrustedSessionAccess(session, extension.id)
            ) {
              return
            }
            try {
              controller.enqueue(value)
            } catch {
              close()
            }
          }
        }
        const abort = (): void => close()
        close = () => {
          if (!subscriptions.delete(subscription)) {
            return
          }
          execution.controller.signal.removeEventListener('abort', abort)
          try {
            controller.close()
          } catch {
            /* Reader already cancelled. */
          }
        }
        subscriptions.add(subscription)
        execution.controller.signal.addEventListener('abort', abort, { once: true })
        if (!isBrowserExtensionExecutionLive(execution)) {
          close()
        }
      },
      cancel() {
        close()
      }
    })
    return new Response(body, { headers: { ...headers, 'content-type': 'application/x-ndjson' } })
  }
  if (route !== '/call' || typeof header.method !== 'string' || !METHODS.has(header.method)) {
    await framed.cancel()
    return refuse(403)
  }
  const text = await framed.body()
  if (text === null) {
    return refuse(413)
  }
  let args: unknown
  try {
    args = decodeBrowserExtensionWireJson(text)
  } catch {
    return refuse(400)
  }
  if (
    !Array.isArray(args) ||
    !admitted(execution) ||
    !browserExtensionUntrustedSessionAccess(session, extension.id)
  ) {
    return refuse(403)
  }
  const caller: BrowserExtensionCaller = {
    session,
    extension,
    browserProfileId: execution.host.browserProfileId,
    execution,
    untrusted: true,
    contentContext: context
  }
  const result = await handleBrowserExtensionApiRequest(
    caller,
    execution.host,
    {
      type: 'call',
      namespace: 'orcaStorageSession',
      method: header.method,
      args
    },
    { kind: 'none' }
  )
  return new Response(encodeBrowserExtensionWireJson(result), {
    headers: { ...headers, 'content-type': 'application/json' }
  })
}
