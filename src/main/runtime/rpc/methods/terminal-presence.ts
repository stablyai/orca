import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { requiredString } from '../schemas'
import { assertPeerTerminalGranted } from '../peer-terminal-grant-guard'

let presenceSubscriptionSeq = 0

const TerminalPresenceSubscribeParams = z.object({
  terminal: requiredString('Missing terminal handle'),
  clientId: requiredString('Missing client ID')
})

const PeerPresenceStateParams = z.object({
  participant: z.object({
    clientId: requiredString('Missing client ID'),
    name: requiredString('Missing participant name'),
    color: requiredString('Missing participant color')
  }),
  cursor: z.object({ col: z.number(), row: z.number() }).nullable(),
  selection: z
    .object({
      startCol: z.number(),
      startRow: z.number(),
      endCol: z.number(),
      endRow: z.number()
    })
    .nullable(),
  scroll: z.object({ atBottom: z.boolean(), scrollTop: z.number() })
})

const TerminalPresenceSendParams = z.object({
  terminal: requiredString('Missing terminal handle'),
  state: PeerPresenceStateParams
})

const TerminalPresenceUnsubscribeParams = z.object({
  subscriptionId: requiredString('Missing subscriptionId')
})

// Why: presence rides the existing JSON-RPC multiplexed channel (like
// notifications.subscribe / runtime.clientEvents.subscribe) instead of a new
// transport — one streaming subscribe per (terminal, connection) receives
// every other participant's state, and a plain fire-and-forget method sends
// this connection's own state for the host to fan out.
export const TERMINAL_PRESENCE_METHODS: readonly RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'terminal.presence.subscribe',
    params: TerminalPresenceSubscribeParams,
    handler: async (params, ctx, emit) => {
      const { runtime, connectionId } = ctx
      assertPeerTerminalGranted(ctx, params.terminal)
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.onPeerPresence(
          params.terminal,
          connectionId ?? `inproc-${++presenceSubscriptionSeq}`,
          (event) => emit(event)
        )

        const seq = ++presenceSubscriptionSeq
        const subscriptionId = `terminal-presence-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            // Why: tell every other viewer this subscribing participant's own
            // cursor/selection is gone (not whichever other participant's
            // state this listener last observed — the listener never sees
            // its own state since dispatchPeerPresence excludes the sender).
            runtime.dispatchPeerPresence(params.terminal, connectionId, {
              type: 'left',
              terminal: params.terminal,
              clientId: params.clientId
            })
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        emit({ type: 'ready', subscriptionId })
      })
    }
  }),
  defineMethod({
    name: 'terminal.presence.send',
    params: TerminalPresenceSendParams,
    handler: async (params, ctx) => {
      const { runtime, connectionId } = ctx
      assertPeerTerminalGranted(ctx, params.terminal)
      runtime.dispatchPeerPresence(params.terminal, connectionId, {
        type: 'state',
        terminal: params.terminal,
        state: params.state
      })
      return { sent: true }
    }
  }),
  defineMethod({
    name: 'terminal.presence.unsubscribe',
    params: TerminalPresenceUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
