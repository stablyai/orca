import { MessageWaitScope } from '../../../../runtime-message-waiters'
import type { MessageRow, MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/formatter'
import { exposeMessages } from './mailbox-message-receipt'
import { routeAllMailboxPages } from '../schemas'
import { asDispatchFence, callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'
import { interruptedAcknowledgedCheck } from '../routing'
import { currentDispatchAssigneeRun } from './recipient-routing'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'

type ActiveDispatch = NonNullable<ReturnType<OrchestrationDb['getActiveDispatchForIdentity']>>

export async function checkWorkerMailbox(args: {
  params: z.infer<typeof CheckParams>
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  activeDispatch: ActiveDispatch | undefined
  remoteAttachment: RemoteDispatchAttachmentRow | undefined
  wakeTypes?: MessageType[]
  revalidateConsumer?: () => void
  deferDelivery?: () => boolean
  recordMutationReceipt?: (receipt: unknown) => void
}) {
  const waitScope = new MessageWaitScope()
  let completionMailbox = args.handle
  const opportunityTypes =
    args.params.peek || args.params.all || args.params.unread === false
      ? args.typeFilter
      : undefined
  try {
    args.runtime.observeMessageCheck(args.handle, waitScope, opportunityTypes)
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
    completionMailbox = address
    runtime.observeMessageCheck(address, waitScope, opportunityTypes)
    if (activeDispatch?.assignee_handle) {
      runtime.observeMessageCheck(activeDispatch.assignee_handle, waitScope, opportunityTypes)
    }
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
        runtime.observeMessageCheck(`run:${owningRunId}`, waitScope, opportunityTypes)
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
    }
    const showAll = params.all === true || (params.unread === false && params.peek !== true)
    const readPeek = () => db.getUnreadMessages(address, typeFilter)
    const readDelivery = (wakeTypes?: MessageType[]) => {
      if (args.deferDelivery?.()) {
        return undefined
      }
      try {
        return db.getOrCreateMailboxDelivery({
          runId: deliveryRunId,
          mailboxHandle: address,
          consumerGeneration: workerMailbox.generation,
          consumerSource: activeDispatch ? 'dispatch' : 'attachment',
          wakeTypes
        })
      } catch (error) {
        throw asDispatchFence(error)
      }
    }
    const peekResult = (messages: MessageRow[]) => ({
      ...mailboxIdentity,
      messages: exposeMessages(messages),
      count: messages.length,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...(params.format || params.inject
        ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
        : {})
    })
    if (showAll) {
      return peekResult(db.getAllMessagesForHandle(address, 100, typeFilter))
    }
    if (params.peek) {
      const messages = readPeek()
      if (messages.length > 0 || !params.wait) {
        return peekResult(messages)
      }
    } else {
      const current = readDelivery(params.wait ? typeFilter : args.wakeTypes)
      if (current || !params.wait) {
        return {
          ...mailboxIdentity,
          deliveryId: current?.delivery.id ?? null,
          messages: exposeMessages(current?.messages ?? []),
          count: current?.messages.length ?? 0,
          replayed: current?.replayed ?? false,
          acknowledged: acknowledged?.delivery.id ?? null,
          timedOut: false,
          cancelled: false,
          connectionLost: false,
          ...(params.format || params.inject
            ? { formatted: current?.messages.map(formatMessageBanner).join('\n\n') ?? '' }
            : {})
        }
      }
    }
    // Binding can happen during recovery, before run-create/run-use can cancel this wait.
    const waitResult =
      activeDispatch && currentDispatchAssigneeRun(runtime, db, activeDispatch)
        ? 'cancelled'
        : await runtime.waitForMessage(address, {
            scope: waitScope,
            typeFilter: typeFilter as string[] | undefined,
            timeoutMs: params.timeoutMs ?? undefined,
            signal
          })
    runtime.observeMessageCheck(address, waitScope, opportunityTypes)
    await revalidateWorkerMailbox()
    if (readCurrentGeneration() !== workerMailbox.generation) {
      throw dispatchFenced()
    }
    if (waitResult === 'timed_out' || waitResult === 'cancelled') {
      return {
        ...mailboxIdentity,
        messages: [],
        count: 0,
        acknowledged: acknowledged?.delivery.id ?? null,
        timedOut: waitResult === 'timed_out',
        cancelled: waitResult === 'cancelled',
        connectionLost: waitResult === 'cancelled' && signal?.aborted === true
      }
    }
    if (params.peek) {
      return peekResult(readPeek())
    }
    const arrived = readDelivery(typeFilter)
    return {
      ...mailboxIdentity,
      deliveryId: arrived?.delivery.id ?? null,
      messages: exposeMessages(arrived?.messages ?? []),
      count: arrived?.messages.length ?? 0,
      replayed: arrived?.replayed ?? false,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...(params.format || params.inject
        ? { formatted: arrived?.messages.map(formatMessageBanner).join('\n\n') ?? '' }
        : {})
    }
  } finally {
    if (!waitScope.complete()) {
      args.runtime.notifyMessageConsumerCompleted(completionMailbox)
    }
  }
}
