import { z } from 'zod'
import type { BrowserExtensionInvokeResult } from '../../../shared/browser-extension-channels'
import {
  BrowserExtensionApiError,
  extensionHasNamespacePermission,
  getBrowserExtensionNamespace,
  type BrowserExtensionCaller,
  type BrowserExtensionNamespacePermission
} from './browser-extension-namespace-registry'
import { flushWorkerQueue } from './browser-extension-worker-event-stream'
import {
  eventKey,
  setFrameListening,
  setListenerFilters,
  type HostSessionState,
  type WorkerContext
} from './browser-extension-contexts'

const invokeRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call'),
    namespace: z.string(),
    method: z.string(),
    args: z.array(z.unknown())
  }),
  z.object({
    type: z.literal('listen'),
    namespace: z.string(),
    event: z.string(),
    active: z.boolean(),
    /** Every listener's filter (webRequest); omitted when one listener takes all events. */
    filters: z.array(z.unknown()).optional()
  })
])

export type BrowserExtensionListenTarget =
  | { kind: 'worker'; context: WorkerContext }
  | { kind: 'frame'; webContents: Electron.WebContents; frame: Electron.WebFrameMain }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Extension API call failed'
}

function requirePermission(
  caller: BrowserExtensionCaller,
  permission: BrowserExtensionNamespacePermission | undefined
): void {
  if (!extensionHasNamespacePermission(caller.extension, permission, caller.session)) {
    const name = [permission].flat()[0]
    throw new BrowserExtensionApiError(`This API requires the "${name}" permission`)
  }
}

/** One call or listen request from a page (IPC) or a worker (protocol), caller already verified. */
export async function handleBrowserExtensionApiRequest(
  caller: BrowserExtensionCaller,
  state: HostSessionState,
  rawRequest: unknown,
  listenTarget: BrowserExtensionListenTarget
): Promise<BrowserExtensionInvokeResult> {
  try {
    const parsed = invokeRequestSchema.safeParse(rawRequest)
    if (!parsed.success) {
      throw new BrowserExtensionApiError('Malformed extension API request')
    }
    const request = parsed.data
    const namespace = getBrowserExtensionNamespace(request.namespace)
    if (!namespace) {
      throw new BrowserExtensionApiError(`chrome.${request.namespace} is not available`)
    }
    requirePermission(caller, namespace.permission)
    if (request.type === 'listen') {
      if (!namespace.events.includes(request.event)) {
        throw new BrowserExtensionApiError(`Unknown event ${request.namespace}.${request.event}`)
      }
      const key = eventKey(request.namespace, request.event)
      if (listenTarget.kind === 'worker') {
        const { context } = listenTarget
        if (request.active) {
          context.events.add(key)
          setListenerFilters(context.filters, key, request.filters)
          flushWorkerQueue(context, key)
        } else {
          context.events.delete(key)
          setListenerFilters(context.filters, key, undefined)
        }
      } else {
        const { webContents, frame } = listenTarget
        setFrameListening(
          state,
          caller.extension.id,
          webContents,
          frame,
          key,
          request.active,
          request.filters
        )
      }
      return { ok: true, value: undefined }
    }
    const method = Object.hasOwn(namespace.methods, request.method)
      ? namespace.methods[request.method]
      : undefined
    if (!method) {
      throw new BrowserExtensionApiError(
        `chrome.${request.namespace}.${request.method} is not available`
      )
    }
    return { ok: true, value: await method.invoke(caller, request.args) }
  } catch (error) {
    if (!(error instanceof BrowserExtensionApiError)) {
      console.warn('[browser-extensions] API call failed:', error)
    }
    return { ok: false, error: errorMessage(error) }
  }
}
