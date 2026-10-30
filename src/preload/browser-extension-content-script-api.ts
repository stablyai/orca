import {
  createContentScriptRelayBridge,
  installContentScriptRelayFilter
} from './browser-extension-content-script-relay'
import { installBrowserExtensionInertApis } from './browser-extension-inert-apis'
import {
  installBrowserExtensionStorageSync,
  PRELOAD_STORAGE_SYNC_CONSTANTS
} from './browser-extension-storage-sync'

/**
 * Orca's content script, bundled into one standalone file that Orca's manifest rewrite puts first
 * in each of the extension's isolated-world content scripts. It adds the content-script APIs
 * Chrome has and Electron lacks, and, when the extension has a worker, chrome.storage.sync through
 * that worker (see browser-extension-content-script-relay.ts).
 */

type ContentScriptRoot = {
  chrome?: {
    runtime?: {
      id?: unknown
      onMessage?: unknown
      sendMessage?: unknown
      getManifest?: () => { background?: unknown }
    }
  }
  __orcaContentScriptApi?: true
}

function hasServiceWorker(runtime: { getManifest?: () => { background?: unknown } }): boolean {
  try {
    const background = runtime.getManifest?.().background
    return (
      typeof background === 'object' &&
      background !== null &&
      'service_worker' in background &&
      typeof background.service_worker === 'string'
    )
  } catch {
    return false
  }
}

const root: ContentScriptRoot = globalThis
// Why the guard: every manifest entry lists this file, and entries share one world per frame.
if (!root.__orcaContentScriptApi && root.chrome) {
  root.__orcaContentScriptApi = true
  installBrowserExtensionInertApis('content-script')
  const runtime = root.chrome.runtime
  const sendMessage = runtime?.sendMessage
  const bridge =
    runtime && typeof sendMessage === 'function' && hasServiceWorker(runtime)
      ? createContentScriptRelayBridge(
          (message) => Promise.resolve(sendMessage.call(runtime, message)),
          runtime
        )
      : null
  installContentScriptRelayFilter()
  if (bridge) {
    installBrowserExtensionStorageSync(bridge, PRELOAD_STORAGE_SYNC_CONSTANTS)
  }
}
