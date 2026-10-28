import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { z } from 'zod'
import { BROWSER_EXTENSION_EVENT_CHANNEL } from '../../../../shared/browser-extension-channels'
import { emitBrowserExtensionWorkerStartEvent } from '../browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { killAllNativeHosts } from '../browser-extension-native-host-process'
import {
  findNativePort,
  openNativePort,
  type NativePortEvent
} from '../browser-extension-native-ports'

/**
 * Backs chrome.runtime.connectNative and sendNativeMessage, which src/preload/
 * browser-extension-native-messaging.ts installs. Preload-only: never on the API surface. Messages
 * travel as JSON text so the host receives exactly what the extension serialized.
 */
const NATIVE_MESSAGING_NAMESPACE = 'orcaNativeMessaging'
const PORT_EVENT = 'onPortEvent'

const portId = z.string().min(1).max(100)
const jsonText = z.string().refine((text) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}, 'not JSON')

/** Sends a port's event to the one context that opened it. */
function deliverToOwner(caller: BrowserExtensionCaller, id: string, event: NativePortEvent): void {
  if (event.type === 'disconnect' && event.teardown) {
    return
  }
  const args =
    event.type === 'message' ? [id, 'message', event.json] : [id, 'disconnect', event.error]
  if (caller.fromWorker) {
    // Why the start-event path: it holds events until the worker's listener registers.
    emitBrowserExtensionWorkerStartEvent(
      caller.session,
      caller.extension.id,
      NATIVE_MESSAGING_NAMESPACE,
      PORT_EVENT,
      args
    )
    return
  }
  const frame = caller.frame
  if (frame && !frame.isDestroyed()) {
    try {
      frame.send(BROWSER_EXTENSION_EVENT_CHANNEL, {
        namespace: NATIVE_MESSAGING_NAMESPACE,
        event: PORT_EVENT,
        args
      })
    } catch {
      // The frame went away; its port is torn down by the frame watchers.
    }
  }
}

/** One message, one reply; the host is closed (and killed after Chrome's grace) once it answers. */
async function sendNativeMessage(
  caller: BrowserExtensionCaller,
  application: string,
  json: string
): Promise<string> {
  let settle: (event: NativePortEvent) => void = () => {}
  const reply = new Promise<string>((resolve, reject) => {
    settle = (event) =>
      event.type === 'message'
        ? resolve(event.json)
        : reject(new BrowserExtensionApiError(event.error))
  })
  // Why: the host may end before the reply is awaited below.
  reply.catch(() => {})
  const port = await openNativePort(caller, `one-shot:${randomUUID()}`, application, (event) =>
    settle(event)
  )
  port.post(json)
  try {
    return await reply
  } finally {
    port.close()
  }
}

export function registerNativeMessagingNamespace(): void {
  registerBrowserExtensionNamespace(NATIVE_MESSAGING_NAMESPACE, {
    permission: 'nativeMessaging',
    methods: {
      connect: defineBrowserExtensionMethod(
        z.tuple([portId, z.string()]),
        async (caller, id, name) => {
          await openNativePort(caller, id, name, (event) => deliverToOwner(caller, id, event))
        }
      ),
      postMessage: defineBrowserExtensionMethod(z.tuple([portId, jsonText]), (caller, id, json) => {
        findNativePort(caller, id)?.post(json)
      }),
      disconnect: defineBrowserExtensionMethod(z.tuple([portId]), (caller, id) => {
        findNativePort(caller, id)?.close()
      }),
      sendNativeMessage: defineBrowserExtensionMethod(
        z.tuple([z.string(), jsonText]),
        (caller, application, json) => sendNativeMessage(caller, application, json)
      )
    },
    events: [PORT_EVENT]
  })
  app.on('will-quit', killAllNativeHosts)
}
