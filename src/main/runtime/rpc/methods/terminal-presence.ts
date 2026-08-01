import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { requiredString } from '../schemas'
import { assertPeerTerminalGranted } from '../peer-terminal-grant-guard'

let presenceSubscriptionSeq = 0

// Why: presence.send fans each payload out to every other subscriber, so
// unbounded fields would let one peer amplify oversized payloads to all viewers.
const presenceCell = z.number().int().min(-1_000_000).max(1_000_000)

const TerminalPresenceSubscribeParams = z.object({
  terminal: requiredString('Missing terminal handle').pipe(z.string().max(256)),
  clientId: requiredString('Missing client ID').pipe(z.string().max(128))
})

const PeerPresenceStateParams = z.object({
  participant: z.object({
    clientId: requiredString('Missing client ID').pipe(z.string().max(128)),
    name: requiredString('Missing participant name').pipe(z.string().max(80)),
    color: requiredString('Missing participant color').pipe(z.string().max(32))
  }),
  cursor: z.object({ col: presenceCell, row: presenceCell }).nullable(),
  selection: z
    .object({
      startCol: presenceCell,
      startRow: presenceCell,
      endCol: presenceCell,
      endRow: presenceCell
    })
    .nullable(),
  scroll: z.object({
    atBottom: z.boolean(),
    scrollTop: z.number().finite().min(-1_000_000_000).max(1_000_000_000)
  })
})

const TerminalPresenceSendParams = z.object({
  terminal: requiredString('Missing terminal handle').pipe(z.string().max(256)),
  state: PeerPresenceStateParams
})

const TerminalPresenceUnsubscribeParams = z.object({
  subscriptionId: requiredString('Missing subscriptionId').pipe(z.string().max(512))
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
        // Why: terminal is embedded (not just connectionId) so a grant revoke can
        // find and tear down this connection's presence sub for that terminal —
        // see RuntimeRpc.setGrantedTerminals.
        const subscriptionId = `terminal-presence:${params.terminal}:${connectionId ?? 'inproc'}-${seq}`
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
    handler: async (params, { runtime, connectionId, isPeerDevice }) => {
      // Why: the id is a guessable string, so a peer may only tear down
      // subscriptions its own connection registered.
      if (isPeerDevice) {
        if (connectionId) {
          runtime.cleanupSubscriptionOwnedBy(params.subscriptionId, connectionId)
        }
        return { unsubscribed: true }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
