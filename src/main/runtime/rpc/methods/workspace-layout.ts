// The read-only layout stream (design 2.4) and the server snapshot read (design 6.3). Not
// advertised as a capability and not on the mobile allowlist: no client calls them until the
// switch, so they are inert.

import {
  LayoutApplyParams,
  LayoutSubscribeParams,
  LayoutUnsubscribeParams
} from '../../../../shared/rpc-contract/workspace-layout-params'
import type { WorkspaceLayoutStreamFrame } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { defineMethod, defineStreamingMethod } from '../core'

let layoutSubscriptionSeq = 0

// Why: keyed by the caller's connection, as session.tabs is, so only the subscriber's connection can end it.
const layoutCleanupKey = (connectionId: string | undefined, subscriptionId: string): string =>
  `layout:${connectionId ?? 'local'}:${subscriptionId}`

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
        const cleanupKey = layoutCleanupKey(connectionId, subscriptionId)
        const release = (): void => runtime.cleanupSubscription(cleanupKey)
        const { snapshot, seq, unsubscribe } = runtime.subscribeWorkspaceLayouts((event) => {
          if (wanted(event.key)) {
            emit(event)
          }
        })
        runtime.registerSubscriptionCleanup(
          cleanupKey,
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
          workspaces: snapshot.filter((entry) => wanted(entry.key)),
          seq
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
    handler: async (params, { runtime, connectionId }) => {
      runtime.cleanupSubscription(layoutCleanupKey(connectionId, params.subscriptionId))
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'layout.getRemoteSnapshots',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({ snapshots: runtime.getRemoteLayoutSnapshots() })
  })
]

/**
 * The window's layout commands (C1). Registered only in a layout-owner build; see methods/index.ts.
 * Main mints new ids except those the window already drew under (its tabs, startup-split panes).
 */
export const LAYOUT_APPLY_METHODS = [
  defineMethod({
    name: 'layout.apply',
    permission: 'workspace',
    params: LayoutApplyParams,
    handler: async (params, { runtime }) => runtime.applyLayoutCommand(params.command)
  })
]
