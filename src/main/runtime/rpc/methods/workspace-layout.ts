// Paired desktops use layout read/stream/apply only when the server offers layout.intents.v1; mobile is excluded.

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

// Connection-owned keys prevent one subscriber from ending another's stream.
const layoutCleanupKey = (connectionId: string | undefined, subscriptionId: string): string =>
  `layout:${connectionId ?? 'local'}:${subscriptionId}`

export const WORKSPACE_LAYOUT_METHODS = [
  defineStreamingMethod({
    name: 'layout.subscribe',
    permission: 'workspace',
    params: LayoutSubscribeParams,
    handler: async (params, { runtime, connectionId, signal }, emitFrame) => {
      // Keep emitted frames checked against the client contract.
      const emit = (frame: WorkspaceLayoutStreamFrame): void => emitFrame(frame)
      const keys = params?.workspaces
      const wanted = (key: string) => !Array.isArray(keys) || keys.includes(key)
      await new Promise<void>((resolve) => {
        const subscriptionId = `layout-${connectionId ?? 'inproc'}-${++layoutSubscriptionSeq}`
        const cleanupKey = layoutCleanupKey(connectionId, subscriptionId)
        const release = (): void => runtime.cleanupSubscription(cleanupKey)
        const { snapshot, seq, epoch, unsubscribe } = runtime.subscribeWorkspaceLayouts((event) => {
          if (event.type === 'records') {
            // Emit even unrelated events so subscriber positions stay gapless.
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
      // Removed servers' saved snapshots must not seed views again.
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

/** Layout-owner builds only: main mints ids except those already drawn by the window (tabs and startup-split panes). */
export const LAYOUT_APPLY_METHODS = [
  defineMethod({
    name: 'layout.apply',
    permission: 'workspace',
    params: LayoutApplyParams,
    handler: async (params, { runtime }) => runtime.applyLayoutCommand(params.command)
  }),
  // Reopen held panes; main's frames, not the reply, show their start.
  defineMethod({
    name: 'layout.reopenHeldPanes',
    permission: 'workspace',
    params: LayoutReopenHeldPanesParams,
    handler: async (params, { runtime }) => runtime.reopenHeldTerminalPanes(params.panes)
  }),
  // The user's Start on panes held for a stopped WSL distro; main's frames show their start.
  defineMethod({
    name: 'layout.startWslHeldPanes',
    permission: 'workspace',
    params: LayoutReopenHeldPanesParams,
    handler: async (params, { runtime }) => runtime.startWslHeldTerminalPanes(params.panes)
  })
]

/** Layout-intents servers accept paired-desktop view reports to route CLI/phone file opens into the displayed group. */
export const LAYOUT_VIEW_REPORT_METHODS = [
  defineMethod({
    name: 'layout.reportView',
    permission: 'workspace',
    params: LayoutReportViewParams,
    handler: async (params, { runtime, connectionId, signal }) => {
      // Reports outlive calls and require connection-close cleanup, as sidebarInputs.reportView does.
      if (connectionId === undefined || signal?.aborted) {
        throw new Error('client_disconnected')
      }
      runtime.reportClientView(connectionId, params.activeGroupByWorkspace, params.refresh === true)
      return { ok: true }
    }
  })
]
