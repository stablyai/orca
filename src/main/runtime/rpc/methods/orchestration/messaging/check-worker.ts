import type { WorkerMailboxCheckInput } from './check-worker-mailbox-input'
import type { MessageRow, MessageType } from '../../../../orchestration/db/orchestration-records'
import type { MailboxDeliveryBatch } from '../../../../orchestration/db/messages/role-mailbox-delivery'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/mailbox/formatting/message-formatting'
import {
  acknowledgedOnlyReceipt,
  deliveryReceipt,
  exposeMessages,
  withReportFollowUps
} from './mailbox-message-receipt'
import { routeAllMailboxPages, createDirectMailSnapshotRouter } from './mailbox-page-routing'
import { asDispatchFence, callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'
import { interruptedAcknowledgedCheck } from '../routing'
import type { MessageWake } from '../../../../orchestration/mailbox/runtime-message-waiters'
import { currentDispatchAssigneeRun } from './recipient-routing'

export async function checkWorkerMailbox(args: WorkerMailboxCheckInput) {
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
  const routeDirectSnapshot = createDirectMailSnapshotRouter(db, signal)
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
  const result = (batch: MailboxDeliveryBatch | undefined) => {
    const receipt = deliveryReceipt({
      mailbox: mailboxIdentity,
      batch,
      acknowledged: acknowledged?.delivery.id ?? args.runAcknowledged,
      format: params.format === true || params.inject === true
    })
    return batch?.finalResponse ? receipt : withReportFollowUps(db, receipt)
  }
  const takeDelivery = async (wakeTypes?: MessageType[], wake?: MessageWake) => {
    if (args.deferDelivery?.()) {
      return undefined
    }
    const revalidate = () => {
      args.revalidateCaller?.()
      args.revalidateConsumer?.()
      if (readCurrentGeneration() !== workerMailbox.generation) {
        throw dispatchFenced()
      }
      if (activeDispatch) {
        const current = db.getActiveDispatchForIdentity(handle, paneKey)
        if (current?.id !== activeDispatch.id || !callerHoldsDispatchPane(current, paneKey)) {
          throw dispatchFenced()
        }
      } else if (
        !paneKey ||
        db.findActiveRemoteAttachmentForPane(paneKey)?.dispatch_id !== workerMailbox.dispatchId ||
        !db.isRemoteAttachmentProcessCurrent({
          dispatchId: workerMailbox.dispatchId,
          paneKey,
          processIncarnation: runtime.getTerminalProcessIncarnation(handle)
        })
      ) {
        throw dispatchFenced()
      }
      if (args.deferDelivery?.()) {
        throw dispatchFenced()
      }
    }
    try {
      return await args.reconciliation.takeRole({
        mailbox: {
          runId: deliveryRunId,
          mailboxHandle: address,
          consumerGeneration: workerMailbox.generation,
          consumerSource: activeDispatch ? 'dispatch' : 'attachment',
          wakeTypes
        },
        revalidate,
        respond: result,
        record: args.recordMutationReceipt,
        wake
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
    const current = await takeDelivery(params.wait ? typeFilter : args.wakeTypes)
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
  const batch = await takeDelivery(typeFilter, waitResult)
  return result(batch)
}
