import type { ContextBridge, IpcRenderer } from 'electron'
import {
  BROWSER_EXTENSION_API_SURFACE,
  PRELOAD_BROWSER_EXTENSION_EVENT_CHANNEL,
  PRELOAD_BROWSER_EXTENSION_INVOKE_CHANNEL
} from './browser-extension-api-surface'
import {
  installBrowserExtensionApis,
  type BrowserExtensionInvokeReply,
  type BrowserExtensionMainWorldBridge
} from './browser-extension-main-world'
import {
  installBrowserExtensionDocumentTargets,
  PRELOAD_FIRST_DISCARDED_TAB_ID
} from './browser-extension-document-targets'
import { passesBrowserExtensionEventFilter } from './browser-extension-event-filters'
import { installBrowserExtensionInertApis } from './browser-extension-inert-apis'
import { installContentScriptRelayFilter } from './browser-extension-content-script-relay'
import { installBrowserExtensionNativeMessaging } from './browser-extension-native-messaging'
import { installBrowserExtensionStorageRelay } from './browser-extension-storage-relay'
import {
  installBrowserExtensionStorageSync,
  PRELOAD_STORAGE_SYNC_CONSTANTS
} from './browser-extension-storage-sync'
import {
  CHROME_WEB_STORE_ORIGIN,
  installChromeWebStoreBridge
} from './browser-extension-web-store-bridge'

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
const electron: { contextBridge: ContextBridge; ipcRenderer: IpcRenderer } = require('electron')
const { contextBridge, ipcRenderer } = electron

// Why frame-only: a service-worker preload crashes the renderer during GC (electron#52310);
// workers get the same installer from Orca's worker shim. Pages stay on IPC because namespaces
// need the calling frame (tabs.getCurrent, popout windows), which only IPC's senderFrame names.

/** The frame's own location: one session preload runs in every page of the session. */
function readContextHref(): string {
  try {
    if (typeof location !== 'undefined' && typeof location.href === 'string') {
      return location.href
    }
  } catch {
    // Fall through to the main world.
  }
  try {
    const href: unknown = contextBridge.executeInMainWorld({
      func: () => String(globalThis.location?.href ?? '')
    })
    return typeof href === 'string' ? href : ''
  } catch {
    return ''
  }
}

async function invoke(request: unknown): Promise<BrowserExtensionInvokeReply> {
  try {
    const reply: BrowserExtensionInvokeReply = await ipcRenderer.invoke(
      PRELOAD_BROWSER_EXTENSION_INVOKE_CHANNEL,
      request,
      navigator.userActivation.isActive
    )
    return reply
  } catch {
    return { ok: false, error: 'Orca could not handle this extension call' }
  }
}

function installExtensionContextApis(): void {
  const dispatchers: ((namespace: string, event: string, args: unknown[]) => void)[] = []
  ipcRenderer.on(PRELOAD_BROWSER_EXTENSION_EVENT_CHANNEL, (_event, payload: unknown) => {
    if (
      payload &&
      typeof payload === 'object' &&
      'namespace' in payload &&
      'event' in payload &&
      'args' in payload
    ) {
      const { namespace, event, args } = payload
      if (typeof namespace === 'string' && typeof event === 'string' && Array.isArray(args)) {
        for (const dispatch of dispatchers) {
          dispatch(namespace, event, args)
        }
      }
    }
  })
  const bridge: BrowserExtensionMainWorldBridge = {
    call: (namespace, method, args) => invoke({ type: 'call', namespace, method, args }),
    listen: (namespace, event, active, filters) => {
      void invoke({ type: 'listen', namespace, event, active, filters })
    },
    onEvent: (handler) => {
      dispatchers.push(handler)
    },
    passesFilter: passesBrowserExtensionEventFilter
  }
  contextBridge.executeInMainWorld({
    func: installBrowserExtensionApis,
    args: [bridge, BROWSER_EXTENSION_API_SURFACE]
  })
  contextBridge.executeInMainWorld({
    func: installBrowserExtensionStorageRelay,
    args: [bridge, 'page']
  })
  contextBridge.executeInMainWorld({
    func: installBrowserExtensionStorageSync,
    args: [bridge, PRELOAD_STORAGE_SYNC_CONSTANTS]
  })
  contextBridge.executeInMainWorld({
    func: installBrowserExtensionNativeMessaging,
    args: [bridge, 'page']
  })
  contextBridge.executeInMainWorld({
    func: installBrowserExtensionDocumentTargets,
    args: [bridge, PRELOAD_FIRST_DISCARDED_TAB_ID]
  })
  // Pages only hide content scripts' relayed sync calls; the worker answers them.
  contextBridge.executeInMainWorld({ func: installContentScriptRelayFilter, args: [] })
  contextBridge.executeInMainWorld({ func: installBrowserExtensionInertApis, args: ['page'] })
}

function readOrigin(href: string): string | null {
  try {
    return new URL(href).origin
  } catch {
    return null
  }
}

// Why: Electron runs offscreen documents without context isolation, where contextBridge throws;
// Chrome gives them only runtime messaging, which Electron already provides.
if (process.contextIsolated) {
  const href = readContextHref()
  if (href.startsWith('chrome-extension://')) {
    // A document marker survives Chromium reusing an existing extension renderer process.
    // Why origin: a manifest sandbox page keeps its extension URL but runs with an opaque origin.
    if (!href.endsWith('/manifest.json?orca-native-page=1') && globalThis.origin !== 'null') {
      installExtensionContextApis()
    }
  } else if (process.isMainFrame && readOrigin(href) === CHROME_WEB_STORE_ORIGIN) {
    installChromeWebStoreBridge()
  }
}
