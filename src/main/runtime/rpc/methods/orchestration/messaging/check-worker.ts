import type { MessageRow, MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { MailboxDeliveryBatch } from '../../../../orchestration/db/messages/role-mailbox-delivery'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/formatter'
import { acknowledgedOnlyReceipt, deliveryReceipt, exposeMessages } from './mailbox-message-receipt'
import { routeAllMailboxPages } from '../schemas'
import { asDispatchFence, callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'
import { interruptedAcknowledgedCheck } from '../routing'
import { currentDispatchAssigneeRun } from './recipient-routing'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'

type CheckParamsInput = z.infer<typeof CheckParams>
type ActiveDispatch = NonNullable<ReturnType<OrchestrationDb['getActiveDispatchForIdentity']>>
type RemoteAttachment = NonNullable<
  ReturnType<OrchestrationDb['findActiveRemoteAttachmentForPane']>
>

export async function checkWorkerMailbox(args: {
  params: CheckParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  activeDispatch: ActiveDispatch | undefined
  remoteAttachment: RemoteAttachment | undefined
  wakeTypes?: MessageType[]
  revalidateConsumer?: () => void
  deferDelivery?: () => boolean
  recordMutationReceipt?: (receipt: unknown) => void
  /** An ack the enclosing Run check already applied, reported when this check applied none. */
  runAcknowledged?: string
  /** The caller's --ack came without --wait, so this check takes no new mail. */
  acknowledgeOnly?: boolean
}) {
  const {
    params,
    runtime,
    db,
    handle,
    paneKey,
    typeFilter,
    signal,
    activeDispatch,
    remoteAttachment
  } = args
  const workerMailbox = activeDispatch
    ? {
        dispatchId: activeDispatch.id,
        runId: activeDispatch.run_id,
        generation: activeDispatch.consumer_generation
      }
    : remoteAttachment
      ? {
          dispatchId: remoteAttachment.dispatch_id,
          runId: remoteAttachment.home_run_id,
          generation: remoteAttachment.consumer_generation
        }
      : undefined
  if (!workerMailbox) {
    return undefined
  }
  const deliveryRunId = workerMailbox.runId
  db.requireRun(deliveryRunId)
  const mailboxIdentity = { runId: deliveryRunId, dispatchId: workerMailbox.dispatchId }
  const address = `dispatch:${workerMailbox.dispatchId}`
  // Federated hosts keep consumer generations on remote_dispatch_attachments, without a dispatch_contexts row.
  const readCurrentGeneration = (): number | undefined =>
    activeDispatch
      ? db.getDispatchContextById(workerMailbox.dispatchId)?.consumer_generation
      : db.getRemoteDispatchAttachment(workerMailbox.dispatchId)?.consumer_generation
  const routeDirectSnapshot = async (
    runId: string,
    directHandle: string,
    routePage: (throughSequence: number) => { routedCount: number; hasMore: boolean }
  ): Promise<void> => {
    const throughSequence = db.getLatestUnreadDirectMessageSequenceForRun(runId, directHandle)
    if (throughSequence !== undefined) {
      await routeAllMailboxPages(() => routePage(throughSequence), signal)
    }
  }
  const revalidateWorkerMailbox = async (): Promise<void> => {
    if (activeDispatch) {
      const current = db.getActiveDispatchForIdentity(handle, paneKey)
      if (current?.id === activeDispatch.id) {
        // Re-attachment during awaits can retain the id while changing the pane.
        if (callerHoldsDispatchPane(current, paneKey)) {
          return
        }
        throw dispatchFenced()
      }
    } else if (remoteAttachment && paneKey) {
      const current = db.findActiveRemoteAttachmentForPane(paneKey)
      if (
        current?.dispatch_id === remoteAttachment.dispatch_id &&
        db.isRemoteAttachmentProcessCurrent({
          dispatchId: current.dispatch_id,
          paneKey,
          processIncarnation: runtime.getTerminalProcessIncarnation(handle)
        })
      ) {
        return
      }
    }
    const latestDispatch = db.getDispatchContextById(workerMailbox.dispatchId)
    const owningRunId = latestDispatch?.run_id ?? activeDispatch?.run_id ?? workerMailbox.runId
    if (
      owningRunId &&
      (!latestDispatch ||
        (latestDispatch.status !== 'pending' && latestDispatch.status !== 'dispatched'))
    ) {
      const throughSequence = db.getLatestUnreadMessageSequence(address)
      if (throughSequence !== undefined) {
        const routedTypes = new Set<MessageType>()
        const routePage = (): { routedCount: number; hasMore: boolean } => {
          const routed = db.routeUnreadDispatchMailboxToRunMailbox(
            workerMailbox.dispatchId,
            owningRunId,
            throughSequence
          )
          for (const routedType of routed.types) {
            routedTypes.add(routedType)
          }
          return routed
        }
        const notifyRoutedTypes = (): void => {
          for (const routedType of routedTypes) {
            runtime.notifyMessageArrived(`run:${owningRunId}`, routedType)
          }
          routedTypes.clear()
        }
        try {
          await routeAllMailboxPages(routePage, signal)
        } catch (error) {
          notifyRoutedTypes()
          if (error instanceof OrchestrationError && error.code === 'request_aborted') {
            setImmediate(() => {
              void routeAllMailboxPages(routePage)
                .catch(() => undefined)
                .finally(notifyRoutedTypes)
            })
          }
          throw error
        }
        notifyRoutedTypes()
      }
    }
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${workerMailbox.dispatchId} is no longer assigned to this worker.`
    )
  }

  if (activeDispatch) {
    await routeDirectSnapshot(activeDispatch.run_id, handle, (throughSequence) =>
      db.routeUnreadDirectMessagesToDispatchMailbox(
        activeDispatch.id,
        activeDispatch.run_id,
        handle,
        throughSequence
      )
    )
    const assigneeHandle = activeDispatch.assignee_handle
    if (assigneeHandle && assigneeHandle !== handle) {
      await routeDirectSnapshot(activeDispatch.run_id, assigneeHandle, (throughSequence) =>
        db.routeUnreadDirectMessagesToDispatchMailbox(
          activeDispatch.id,
          activeDispatch.run_id,
          assigneeHandle,
          throughSequence
        )
      )
    }
  }
  await revalidateWorkerMailbox()
  args.revalidateConsumer?.()
  let acknowledged
  try {
    acknowledged = params.ack
      ? db.acknowledgeMailboxDelivery({
          runId: deliveryRunId,
          mailboxHandle: address,
          consumerGeneration: workerMailbox.generation,
          consumerSource: activeDispatch ? 'dispatch' : 'attachment',
          deliveryId: params.ack
        })
      : undefined
  } catch (error) {
    throw asDispatchFence(error)
  }
  if (acknowledged) {
    args.recordMutationReceipt?.(
      interruptedAcknowledgedCheck(deliveryRunId, acknowledged.delivery.id, 'outcome_unknown')
    )
    if (args.acknowledgeOnly) {
      return acknowledgedOnlyReceipt(mailboxIdentity, acknowledged.delivery.id)
    }
  }
  const formatted = (messages: MessageRow[]) =>
    params.format || params.inject
      ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
      : {}
  const showAll = params.all === true || (params.unread === false && params.peek !== true)
  const readPeek = () => db.getUnreadMessages(address, typeFilter)
  const result = (batch: MailboxDeliveryBatch | undefined) =>
    deliveryReceipt({
      mailbox: mailboxIdentity,
      batch,
      acknowledged: acknowledged?.delivery.id ?? args.runAcknowledged,
      format: params.format === true || params.inject === true
    })
  // The receipt commits with the take, so --retry-request can always replay a handed-over batch.
  const takeDelivery = (wakeTypes?: MessageType[]) => {
    if (args.deferDelivery?.()) {
      return undefined
    }
    try {
      return db.takeMailboxDelivery({
        runId: deliveryRunId,
        mailboxHandle: address,
        consumerGeneration: workerMailbox.generation,
        consumerSource: activeDispatch ? 'dispatch' : 'attachment',
        wakeTypes,
        recordTaken: (taken) => args.recordMutationReceipt?.(result(taken))
      })
    } catch (error) {
      throw asDispatchFence(error)
    }
  }
  if (showAll) {
    const messages = db.getAllMessagesForHandle(address, 100, typeFilter)
    return {
      ...mailboxIdentity,
      messages: exposeMessages(messages),
      count: messages.length,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...formatted(messages)
    }
  }
  if (params.peek) {
    const messages = readPeek()
    if (messages.length > 0 || !params.wait) {
      return {
        ...mailboxIdentity,
        messages: exposeMessages(messages),
        count: messages.length,
        acknowledged: acknowledged?.delivery.id ?? null,
        ...formatted(messages)
      }
    }
  } else {
    const current = takeDelivery(params.wait ? typeFilter : args.wakeTypes)
    if (current || !params.wait) {
      return result(current)
    }
  }
  // Binding can happen during recovery, before run-create/run-use can cancel this wait.
  const waitResult =
    activeDispatch && currentDispatchAssigneeRun(runtime, db, activeDispatch)
      ? 'cancelled'
      : await runtime.waitForMessage(address, {
          typeFilter: typeFilter as string[] | undefined,
          timeoutMs: params.timeoutMs ?? undefined,
          signal
        })
  await revalidateWorkerMailbox()
  if (readCurrentGeneration() !== workerMailbox.generation) {
    throw dispatchFenced()
  }
  if (waitResult === 'timed_out' || waitResult === 'cancelled') {
    return {
      ...result(undefined),
      timedOut: waitResult === 'timed_out',
      cancelled: waitResult === 'cancelled',
      connectionLost: waitResult === 'cancelled' && signal?.aborted === true
    }
  }
  if (params.peek) {
    const arrived = readPeek()
    return {
      ...mailboxIdentity,
      messages: exposeMessages(arrived),
      count: arrived.length,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...formatted(arrived)
    }
  }
  const key = `${address}:${workerMailbox.generation}`
  const batch = waitResult.share(key, () => takeDelivery(typeFilter))
  // A waiter that shares another's take has no take transaction, so it receipts the batch on arrival.
  args.recordMutationReceipt?.(result(batch))
  return result(batch)
}
