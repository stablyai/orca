import {
  DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_EXPECT_URL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY,
  DesktopBrowserBridgeAttachParams,
  DesktopBrowserBridgeResultChunkParams,
  DesktopBrowserBridgeResultParams
} from '../../../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import {
  DESKTOP_BROWSER_BRIDGE_DOWNLOAD_ABORT_METHOD,
  DESKTOP_BROWSER_BRIDGE_DOWNLOAD_WRITE_METHOD,
  DESKTOP_BROWSER_BRIDGE_FILE_READ_METHOD,
  DesktopBrowserBridgeDownloadAbortParams,
  DesktopBrowserBridgeDownloadWriteParams,
  DesktopBrowserBridgeFileReadParams
} from '../../../../../shared/browser/client-hosting/desktop-browser-bridge-file-transfer-protocol'
import {
  getDesktopBrowserBridgeRegistry,
  isDesktopBrowserBridgeHostEnabled
} from '../../../desktop-browser-bridge/desktop-browser-bridge-registry'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../../core'

function requireBridgeCaller(context: RpcContext): {
  connectionId: string
  pairedDeviceId: string
} {
  if (!isDesktopBrowserBridgeHostEnabled()) {
    throw new Error('desktop_browser_bridge_not_served')
  }
  const { clientKind, connectionId, pairedDeviceId, clientCapabilities } = context
  // Host commands require an authenticated, E2EE paired-desktop socket.
  if (clientKind !== 'runtime' || !connectionId || !pairedDeviceId) {
    throw new Error('authenticated_desktop_browser_bridge_required')
  }
  if (!clientCapabilities?.includes(DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY)) {
    throw new Error('desktop_browser_bridge_capability_required')
  }
  return { connectionId, pairedDeviceId }
}

export const DESKTOP_BROWSER_BRIDGE_RPC_METHODS = [
  defineStreamingMethod({
    name: 'desktopBrowserBridge.attach',
    permission: 'workspace',
    params: DesktopBrowserBridgeAttachParams,
    handler: async (params, context, emit) => {
      const caller = requireBridgeCaller(context)
      const { runtime, signal } = context
      const acceptsCancel =
        context.clientCapabilities?.includes(DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY) ?? false
      const handle = getDesktopBrowserBridgeRegistry(runtime).attach({
        ...caller,
        acceptsCancel,
        enforcesExpectUrl:
          context.clientCapabilities?.includes(DESKTOP_BROWSER_BRIDGE_EXPECT_URL_CAPABILITY) ??
          false,
        capabilities: context.clientCapabilities ?? [],
        emit
      })
      let release = (): void => {}
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        handle.detach()
        release()
      }
      try {
        runtime.registerSubscriptionCleanup(
          `desktop-browser-bridge:${params.bridgeClientId}:${handle.attachmentId}`,
          cleanup,
          caller.connectionId
        )
        signal?.addEventListener('abort', cleanup, { once: true })
        if (signal?.aborted) {
          return
        }
        emit({ type: 'ready', attachmentId: handle.attachmentId })
        await released
      } finally {
        signal?.removeEventListener('abort', cleanup)
        cleanup()
      }
    }
  }),
  defineMethod({
    name: 'desktopBrowserBridge.resultChunk',
    permission: 'workspace',
    params: DesktopBrowserBridgeResultChunkParams,
    handler: (params, context) => {
      const caller = requireBridgeCaller(context)
      return {
        accepted: getDesktopBrowserBridgeRegistry(context.runtime).appendResultChunk(caller, params)
      }
    }
  }),
  defineMethod({
    name: 'desktopBrowserBridge.result',
    permission: 'workspace',
    params: DesktopBrowserBridgeResultParams,
    handler: (params, context) => {
      const caller = requireBridgeCaller(context)
      return { accepted: getDesktopBrowserBridgeRegistry(context.runtime).settle(caller, params) }
    }
  }),
  defineMethod({
    name: DESKTOP_BROWSER_BRIDGE_FILE_READ_METHOD,
    permission: 'workspace',
    params: DesktopBrowserBridgeFileReadParams,
    handler: (params, context) =>
      getDesktopBrowserBridgeRegistry(context.runtime).readHostFile(
        requireBridgeCaller(context),
        params
      )
  }),
  defineMethod({
    name: DESKTOP_BROWSER_BRIDGE_DOWNLOAD_WRITE_METHOD,
    permission: 'workspace',
    params: DesktopBrowserBridgeDownloadWriteParams,
    handler: async (params, context) => ({
      accepted: true as const,
      ...(await getDesktopBrowserBridgeRegistry(context.runtime).writeDownload(
        requireBridgeCaller(context),
        params
      ))
    })
  }),
  defineMethod({
    name: DESKTOP_BROWSER_BRIDGE_DOWNLOAD_ABORT_METHOD,
    permission: 'workspace',
    params: DesktopBrowserBridgeDownloadAbortParams,
    handler: (params, context) => ({
      released: getDesktopBrowserBridgeRegistry(context.runtime).abortDownload(
        requireBridgeCaller(context),
        params
      )
    })
  })
]
