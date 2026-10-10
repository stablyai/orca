// The read-only layout stream (design 2.4). Not advertised as a capability and not on the mobile
// allowlist: no client calls it until the switch, so it is inert.

import {
  LayoutSubscribeParams,
  LayoutUnsubscribeParams
} from '../../../../shared/rpc-contract/workspace-layout-params'
import type { WorkspaceLayoutStreamFrame } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { defineMethod, defineStreamingMethod } from '../core'

let layoutSubscriptionSeq = 0

export const WORKSPACE_LAYOUT_METHODS = [
  defineStreamingMethod({
    name: 'layout.subscribe',
    permission: 'workspace',
    params: LayoutSubscribeParams,
    handler: async (params, { runtime, connectionId, signal }, emitFrame) => {
      // Typed so the frames stay the contract the client reads.
      const emit = (frame: WorkspaceLayoutStreamFrame): void => emitFrame(frame)
      const keys = params?.workspaces
      const wanted = (key: string) => !Array.isArray(keys) || keys.includes(key)
      await new Promise<void>((resolve) => {
        const subscriptionId = `layout-${connectionId ?? 'inproc'}-${++layoutSubscriptionSeq}`
        const release = (): void => runtime.cleanupSubscription(subscriptionId)
        const { snapshot, unsubscribe } = runtime.subscribeWorkspaceLayouts((event) => {
          if (wanted(event.key)) {
            emit(event)
          }
        })
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            signal?.removeEventListener('abort', release)
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        signal?.addEventListener('abort', release, { once: true })
        emit({
          type: 'snapshot',
          subscriptionId,
          workspaces: snapshot.filter((entry) => wanted(entry.key))
        })
        if (signal?.aborted) {
          release()
        }
      })
    }
  }),
  defineMethod({
    name: 'layout.unsubscribe',
    permission: 'workspace',
    params: LayoutUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
