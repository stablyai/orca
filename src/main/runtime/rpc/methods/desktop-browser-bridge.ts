import {
  DESKTOP_BROWSER_BRIDGE_CANCEL_CAPABILITY,
  DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY,
  DesktopBrowserBridgeAttachParams,
  DesktopBrowserBridgeResultParams
} from '../../../../shared/desktop-browser-bridge-protocol'
import {
  getDesktopBrowserBridgeRegistry,
  isDesktopBrowserBridgeHostEnabled
} from '../../desktop-browser-bridge/desktop-browser-bridge-registry'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'

function requireBridgeCaller(context: RpcContext): {
  connectionId: string
  pairedDeviceId: string
} {
  if (!isDesktopBrowserBridgeHostEnabled()) {
    throw new Error('desktop_browser_bridge_not_served')
  }
  const { clientKind, connectionId, pairedDeviceId, clientCapabilities } = context
  // Why: only an authenticated, end-to-end encrypted paired desktop socket may receive the host's commands.
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
    name: 'desktopBrowserBridge.result',
    permission: 'workspace',
    params: DesktopBrowserBridgeResultParams,
    handler: (params, context) => {
      const caller = requireBridgeCaller(context)
      return { accepted: getDesktopBrowserBridgeRegistry(context.runtime).settle(caller, params) }
    }
  })
]
