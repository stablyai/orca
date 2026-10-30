import { defineMethod } from '../../core'
import { TerminalHandle } from '../../../../../shared/rpc-contract/terminal-unary-params'
import {
  TerminalSetAutoRestoreFit,
  TerminalSetDisplayMode,
  TerminalUnsubscribe,
  TerminalUpdateViewport
} from '../../../../../shared/rpc-contract/terminal-viewport-schemas-params'
import { updateViewportForClient } from './terminal-viewport-update'
import { TerminalGetAutoRestoreFitParams } from '../../../../../shared/rpc-contract/terminal-viewport-methods-params'

export const TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS = [
  defineMethod({
    name: 'terminal.setDisplayMode',
    permission: 'workspace',
    params: TerminalSetDisplayMode,
    handler: async (params, { runtime }) => {
      // Reject stale handles before changing the wrong PTY's display mode or viewport (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      // Late-bind desktop subscriber viewport so auto mode still phone-fits.
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
    permission: 'workspace',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      // Reject stale handles before reclaiming the wrong PTY to desktop size (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      return { restored: await runtime.reclaimTerminalForDesktop(leaf.ptyId) }
    }
  }),
  defineMethod({
    name: 'terminal.getDisplayMode',
    permission: 'workspace',
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
    permission: 'workspace',
    params: TerminalUpdateViewport,
    handler: async (params, { runtime }) => {
      // Reject stale handles before writing the wrong PTY's viewport (#7718).
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
        // One-shot RPC owns no disconnect cleanup; refresh an existing stream floor only.
        'refresh',
        params.claim === true
      )
      return { ...viewportUpdate, seq: runtime.getLayout(leaf.ptyId)?.seq }
    }
  })
]

export const TERMINAL_VIEWPORT_METHODS_AFTER_STREAMS = [
  defineMethod({
    name: 'terminal.unsubscribe',
    permission: 'workspace',
    params: TerminalUnsubscribe,
    handler: async (params, { runtime, connectionId, subscriptionRegistrationVersion }) => {
      if (params.requestId !== undefined) {
        // Unknown requests cannot fall back to a slot that may hold a newer stream.
        runtime.releaseSubscriptionByRequest(connectionId, params.requestId)
        return { unsubscribed: true }
      }
      // COMPAT(terminal request-addressed unsubscribe): slot path for phones that predate `requestId`.
      // Fence both socket replacement and a newer subscription on the same socket.
      let unsubscribed = runtime.cleanupSubscriptionIfOwnedByConnection(
        params.subscriptionId,
        connectionId,
        subscriptionRegistrationVersion
      )
      // Older builds use bare-handle ids; try reconstructed client keys too. AND actual teardown results: missing ids are not refusals.
      if (params.client && !params.subscriptionId.includes(':')) {
        unsubscribed =
          runtime.cleanupSubscriptionIfOwnedByConnection(
            `${params.subscriptionId}:${params.client.id}`,
            connectionId,
            subscriptionRegistrationVersion
          ) && unsubscribed
      }
      return { unsubscribed }
    }
  }),
  defineMethod({
    name: 'terminal.getAutoRestoreFit',
    permission: 'workspace',
    params: TerminalGetAutoRestoreFitParams,
    handler: async (_params, { runtime }) => ({
      ms: runtime.getMobileAutoRestoreFitMs()
    })
  }),
  defineMethod({
    name: 'terminal.setAutoRestoreFit',
    permission: 'workspace',
    params: TerminalSetAutoRestoreFit,
    handler: async (params, { runtime }) => ({
      ms: runtime.setMobileAutoRestoreFitMs(params.ms)
    })
  })
]
