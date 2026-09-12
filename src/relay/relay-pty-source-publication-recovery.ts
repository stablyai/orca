import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  registerCanceledPtySourceRetirement,
  registerPtySourceActivationSettlement
} from './relay-pty-source-activation'
import type {
  RelayPtySourceDeliveryRecord,
  RelayPtySourceSendScheduler
} from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export function requirePtySourceRestore(args: {
  id: string
  current: RelayPtySourceDeliveryRecord
  context: RequestContext
  reason: string
  session: SshPtyConsumerSessionAdapter
  sender: RelayPtySourceSendScheduler
  deliveries: Map<string, RelayPtySourceDeliveryRecord>
  dispatcher: RelayDispatcher
  onCapacity: (id: string) => void
}): Readonly<{ status: 'restoreRequired'; reason: string }> {
  args.session.cancelDelivery(args.current.identity, `recovery-${args.reason}`)
  args.current.restoreRequired = true
  args.current.activating = false
  args.sender.wakeSendWaiters(args.current)
  registerCanceledPtySourceRetirement(args.current, args.context, args.deliveries, args.onCapacity)
  return publishPtySourceRestoreRequired(args)
}

export function registerActivationSettlement(
  id: string,
  record: RelayPtySourceDeliveryRecord,
  context: RequestContext,
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  session: SshPtyConsumerSessionAdapter,
  sender: RelayPtySourceSendScheduler,
  onCapacity: (id: string) => void
): void {
  registerPtySourceActivationSettlement({
    id,
    record,
    context,
    deliveries,
    session,
    sender,
    onCapacity
  })
}

export function createActivationSettlementRegistrar(
  deliveries: Map<string, RelayPtySourceDeliveryRecord>,
  session: SshPtyConsumerSessionAdapter,
  sender: RelayPtySourceSendScheduler,
  onCapacity: (id: string) => void
): (id: string, record: RelayPtySourceDeliveryRecord, context: RequestContext) => void {
  return (id, record, context) =>
    registerActivationSettlement(id, record, context, deliveries, session, sender, onCapacity)
}

export function publishPtySourceRestoreRequired(args: {
  id: string
  context: RequestContext
  reason: string
  dispatcher: RelayDispatcher
  onCapacity: (id: string) => void
}): Readonly<{ status: 'restoreRequired'; reason: string }> {
  const result = Object.freeze({ status: 'restoreRequired' as const, reason: args.reason })
  args.context.onResponseSettled?.((settlement) => {
    if (settlement.ok) {
      args.dispatcher.notifyClient(args.context.clientId, 'pty.restoreRequired', {
        id: args.id,
        reason: args.reason
      })
    }
  })
  args.onCapacity(args.id)
  return result
}
