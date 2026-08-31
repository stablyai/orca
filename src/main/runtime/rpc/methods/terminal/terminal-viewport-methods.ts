import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../../core'
import { TerminalHandle } from './unary-schemas'
import {
  TerminalSetAutoRestoreFit,
  TerminalSetDisplayMode,
  TerminalUnsubscribe,
  TerminalUpdateViewport
} from './viewport-schemas'
import { updateViewportForClient } from './terminal-viewport-update'

export const TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.setDisplayMode',
    params: TerminalSetDisplayMode,
    handler: async (params, { runtime }) => {
      // Why: a stale handle must fail with terminal_handle_stale, not mutate the wrong PTY's display mode/viewport (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      // Why: late-bind viewport for desktop-subscribed callers; otherwise an 'auto' toggle skips phone-fit and nothing resizes.
      if (params.viewport && params.client?.id) {
        runtime.updateMobileSubscriberViewport(leaf.ptyId, params.client.id, params.viewport)
      }
      if (params.client && params.client.type === 'mobile' && params.mode !== 'desktop') {
        runtime.markMobileActor(leaf.ptyId, params.client.id)
      }
      runtime.setMobileDisplayMode(leaf.ptyId, params.mode)
      await runtime.applyMobileDisplayMode(leaf.ptyId)
      return { mode: params.mode, seq: runtime.getLayout(leaf.ptyId)?.seq }
    }
  }),
  defineMethod({
    name: 'terminal.restoreFit',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      // Why: a stale handle must fail with terminal_handle_stale, not reclaim the wrong PTY to desktop dims (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      return { restored: await runtime.reclaimTerminalForDesktop(leaf.ptyId) }
    }
  }),
  defineMethod({
    name: 'terminal.getDisplayMode',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      const mode = leaf?.ptyId ? runtime.getMobileDisplayMode(leaf.ptyId) : 'auto'
      const isPhoneFitted = leaf?.ptyId ? runtime.isMobileSubscriberActive(leaf.ptyId) : false
      return { mode, isPhoneFitted }
    }
  }),
  defineMethod({
    name: 'terminal.updateViewport',
    params: TerminalUpdateViewport,
    handler: async (params, { runtime }) => {
      // Why: a stale handle must fail with terminal_handle_stale, not write viewport state to the wrong PTY (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      const viewportUpdate = await updateViewportForClient(
        runtime,
        leaf.ptyId,
        `viewport:${params.client.id}`,
        params.client,
        params.viewport,
        'mobile',
        // Why: one-shot RPC with no disconnect hook — refresh the existing stream-owned floor, never create a leak-prone one.
        'refresh',
        params.claim === true
      )
      return { ...viewportUpdate, seq: runtime.getLayout(leaf.ptyId)?.seq }
    }
  })
]

export const TERMINAL_VIEWPORT_METHODS_AFTER_STREAMS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.unsubscribe',
    params: TerminalUnsubscribe,
    handler: async (params, { runtime, connectionId }) => {
      // Why: only the connection that owns the subscription may retire it — a stale
      // unsubscribe from the pre-reconnect socket names an id the replacement now owns.
      let unsubscribed = runtime.cleanupSubscriptionIfOwnedByConnection(
        params.subscriptionId,
        connectionId
      )
      // Why: older builds send a bare-handle subscriptionId, so also try the reconstructed `${terminal}:${clientId}` composite key.
      // Why AND over the calls that ran: a clientless stream registers under the bare id
      // and a client-scoped one under the composite, so either call can be the real
      // teardown. Reporting false needs one genuine refusal, not merely a missing id.
      if (params.client && !params.subscriptionId.includes(':')) {
        unsubscribed =
          runtime.cleanupSubscriptionIfOwnedByConnection(
            `${params.subscriptionId}:${params.client.id}`,
            connectionId
          ) && unsubscribed
      }
      return { unsubscribed }
    }
  }),
  defineMethod({
    name: 'terminal.getAutoRestoreFit',
    params: z.object({}),
    handler: async (_params, { runtime }) => ({
      ms: runtime.getMobileAutoRestoreFitMs()
    })
  }),
  defineMethod({
    name: 'terminal.setAutoRestoreFit',
    params: TerminalSetAutoRestoreFit,
    handler: async (params, { runtime }) => ({
      ms: runtime.setMobileAutoRestoreFitMs(params.ms)
    })
  })
]
