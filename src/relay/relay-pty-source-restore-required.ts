import type { RelayDispatcher, RequestContext } from './dispatcher'
import { registerCanceledPtySourceRetirement } from './relay-pty-source-activation'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import type { RelayPtySourceSendScheduler } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export type PtySourceRestoreRequiredResult = Readonly<{
  status: 'restoreRequired'
  reason: string
}>

type RestoreRequiredDeps = {
  dispatcher: RelayDispatcher
  onCapacity: (id: string) => void
}

/**
 * Tell one client it must restore, once the response carrying that verdict has actually landed.
 *
 * Why the settlement fence: the notification is only meaningful to a client that received the
 * response it answers. Firing it eagerly would reach a client that never learned why, or a socket
 * that has already gone — and a restoreRequired the client cannot correlate reads as an expired
 * session, which is the one outcome this path exists to avoid.
 */
export function publishPtySourceRestoreRequired(
  deps: RestoreRequiredDeps,
  id: string,
  context: RequestContext,
  reason: string
): PtySourceRestoreRequiredResult {
  const result = Object.freeze({ status: 'restoreRequired' as const, reason })
  context.onResponseSettled?.((settlement) => {
    if (settlement.ok) {
      deps.dispatcher.notifyClient(context.clientId, 'pty.restoreRequired', { id, reason })
    }
  })
  deps.onCapacity(id)
  return result
}

/**
 * Retire a delivery that cannot be resumed, then tell its client to restore.
 *
 * Why cancel before publishing: the credit ledger holds one upstream owner per pty, and a record
 * left open under a delivery nobody will resume strands that slot — the next open then fails with
 * "already has an upstream owner", which surfaces as an error toast and a blank pane rather than
 * as the recoverable restore this is meant to be.
 */
export function requirePtySourceRestore(
  deps: RestoreRequiredDeps & {
    session: SshPtyConsumerSessionAdapter
    sender: RelayPtySourceSendScheduler
    deliveries: Map<string, RelayPtySourceDeliveryRecord>
  },
  id: string,
  current: RelayPtySourceDeliveryRecord,
  context: RequestContext,
  reason: string
): PtySourceRestoreRequiredResult {
  deps.session.cancelDelivery(current.identity, `recovery-${reason}`)
  current.restoreRequired = true
  current.activating = false
  deps.sender.wakeSendWaiters(current)
  registerCanceledPtySourceRetirement(current, context, deps.deliveries, deps.onCapacity)
  return publishPtySourceRestoreRequired(deps, id, context, reason)
}
