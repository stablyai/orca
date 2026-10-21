// The layout stream (design 2.4), the server snapshot read (design 6.3) and layout.apply. Paired
// desktops may call them; a desktop relies on them only on a server advertising
// `layout.intents.v1` (layout-intents-capability.ts). Not on the mobile allowlist.

import {
  LayoutApplyParams,
  LayoutReportViewParams,
  LayoutSubscribeParams,
  LayoutUnsubscribeParams
} from '../../../../shared/rpc-contract/workspace-layout-params'
import { LayoutReopenHeldPanesParams } from '../../../../shared/rpc-contract/workspace-layout-held-panes-params'
import type { WorkspaceLayoutStreamFrame } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { defineMethod, defineStreamingMethod } from '../core'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { listEnvironments } from '../../../../shared/runtime-environment-store'

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
        const { snapshot, seq, epoch, unsubscribe } = runtime.subscribeWorkspaceLayouts((event) => {
          if (event.type === 'records') {
            // Sent even when it names none of them, so the subscriber's positions stay gapless.
            emit({ ...event, workspaces: event.workspaces.filter((change) => wanted(change.key)) })
          } else if (wanted(event.key)) {
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
          seq,
          ...(epoch ? { epoch } : {})
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
    handler: async (_params, { runtime }) => {
      // Only servers still paired: a removed server's last layout must not seed a view again.
      const known = new Set(
        listEnvironments(getAppEnvironment().getPath('userData')).map(({ id }) => id)
      )
      return {
        snapshots: Object.fromEntries(
          Object.entries(runtime.getRemoteLayoutSnapshots()).filter(([id]) => known.has(id))
        )
      }
    }
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
  }),
  // A paired desktop's Reopen of held panes; main's frames, not the reply, show them start.
  defineMethod({
    name: 'layout.reopenHeldPanes',
    permission: 'workspace',
    params: LayoutReopenHeldPanesParams,
    handler: async (params, { runtime }) => runtime.reopenHeldTerminalPanes(params.panes)
  })
]

/** A paired desktop's view of this server's workspaces, so a CLI or phone file opens in the group it
 *  shows. Registered with layout.apply: only a server advertising `layout.intents.v1` takes it. */
export const LAYOUT_VIEW_REPORT_METHODS = [
  defineMethod({
    name: 'layout.reportView',
    permission: 'workspace',
    params: LayoutReportViewParams,
    handler: async (params, { runtime, connectionId, signal }) => {
      // A report outlives the call, so it needs a connection whose close drops it (as sidebarInputs.reportView).
      if (connectionId === undefined || signal?.aborted) {
        throw new Error('client_disconnected')
      }
      runtime.reportClientView(connectionId, params.activeGroupByWorkspace, params.refresh === true)
      return { ok: true }
    }
  })
]
