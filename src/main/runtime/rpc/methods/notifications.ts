import { z } from 'zod'
import { defineStreamingMethod, defineMethod, type RpcAnyMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

// Why: monotonically increasing per-process counter eliminates the
// Date.now() collision that could fire when two near-simultaneous
// notifications.subscribe calls landed on the same millisecond.
let notificationsSubscriptionSeq = 0

const NotificationUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

// Why: `notifications.dispatch` is the agent-facing trigger behind `orca notify`.
// It carries an arbitrary message and (via the resolved pane) deep-links the
// tap to a specific terminal on desktop and mobile. `message` is required;
// `terminal`/`worktree` select which pane the tap should focus (optional — a
// bare notify still fires without click routing).
const NotificationDispatchParams = z.object({
  message: requiredString('Missing --message'),
  title: OptionalString,
  terminal: OptionalString,
  worktree: OptionalString
})

/**
 * Registers notification RPC methods for mobile subscriptions and agent dispatch.
 *
 * Mobile subscriptions reuse the persistent WebSocket as the push channel,
 * while `notifications.dispatch` backs the CLI-triggered notification path.
 */
export const NOTIFICATION_METHODS: readonly RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'notifications.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.onNotificationDispatched((event) => {
          emit(event)
        })

        // Why: scope by per-ws connectionId + per-process counter so
        // concurrent subscribes never collide on the cleanup map.
        const seq = ++notificationsSubscriptionSeq
        const subscriptionId = `notifications-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
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
    name: 'notifications.unsubscribe',
    params: NotificationUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'notifications.dispatch',
    params: NotificationDispatchParams,
    handler: async (params, { runtime }) => {
      let worktreeId: string | undefined
      let paneKey: string | undefined
      try {
        // Reuse the exact resolution `terminal focus` uses: an explicit handle,
        // else the active terminal in the selected (or current) worktree.
        const handle = params.terminal ?? (await runtime.resolveActiveTerminal(params.worktree))
        const terminal = await runtime.showTerminal(handle)
        worktreeId = terminal.worktreeId
        if (terminal.tabId && !terminal.tabId.includes(':') && isTerminalLeafId(terminal.leafId)) {
          paneKey = makePaneKey(terminal.tabId, terminal.leafId)
        }
      } catch (error) {
        // Why: a bare `orca notify --message …` with no live terminal should
        // still fire a plain notification. Only surface the error when the
        // caller explicitly named a target that could not be resolved.
        if (params.terminal || params.worktree) {
          throw error
        }
      }

      const result = await runtime.dispatchNotification({
        source: 'dispatch',
        message: params.message,
        ...(params.title ? { title: params.title } : {}),
        ...(worktreeId ? { worktreeId } : {}),
        ...(paneKey ? { paneKey } : {})
      })

      return {
        dispatch: {
          ...result,
          ...(worktreeId ? { worktreeId } : {}),
          ...(paneKey ? { paneKey } : {})
        }
      }
    }
  })
]
