import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { BrowserClientHostAttachParams } from '../../../../shared/browser-client-host-protocol'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry'
import { defineStreamingMethod, type RpcAnyMethod } from '../core'

export const BROWSER_CLIENT_HOST_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'browser.clientHost.attach',
    params: BrowserClientHostAttachParams,
    handler: async (
      params,
      { runtime, connectionId, pairedDeviceId, clientKind, clientCapabilities, signal },
      emit
    ) => {
      if (clientKind !== 'runtime' || !connectionId || !pairedDeviceId) {
        throw new Error('authenticated_browser_client_host_required')
      }
      if (!clientCapabilities?.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)) {
        throw new Error('browser_client_host_capability_required')
      }
      if (params.authorityRuntimeId !== runtime.getRuntimeId()) {
        throw new Error('browser_client_host_authority_mismatch')
      }

      const registry = getBrowserHostLeaseRegistry(runtime)
      const handle = registry.attach({
        browserHostClientId: params.browserHostClientId,
        connectionId,
        pairedDeviceId,
        hostCapabilities: params.hostCapabilities
      })
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        handle.release()
      }
      const subscriptionId = `browser-client-host:${params.browserHostClientId}`
      try {
        runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
        signal?.addEventListener('abort', cleanup, { once: true })
        if (signal?.aborted) {
          cleanup()
          return
        }
        emit({
          type: 'ready',
          authorityEpoch: handle.lease.authorityEpoch,
          browserHostGeneration: handle.lease.browserHostGeneration,
          ...(params.pageCommandProtocolVersion
            ? { pageCommandProtocolVersion: params.pageCommandProtocolVersion }
            : {})
        })
        const reason = await handle.whenFenced
        emit({
          type: 'revoked',
          authorityEpoch: handle.lease.authorityEpoch,
          browserHostGeneration: handle.lease.browserHostGeneration,
          reason: reason === 'replaced' ? 'replaced' : 'released'
        })
      } finally {
        signal?.removeEventListener('abort', cleanup)
        cleanup()
      }
    }
  })
]
