import type { MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/formatter'
import { exposeMessages } from './mailbox-message-receipt'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration-rpc-contract'
import { routeAllMailboxPages } from '../schemas'
import { asDispatchFence, callerHoldsDispatchPane, dispatchFenced } from './dispatch-mailbox-fence'
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
}): Promise<unknown> {
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
          runId: undefined,
          generation: remoteAttachment.consumer_generation
        }
      : undefined
  if (!workerMailbox) {
    return undefined
  }
  const address = `dispatch:${workerMailbox.dispatchId}`
  // Why: a federated worker host has no dispatch_contexts row, so its generation lives on the
  // remote_dispatch_attachments row instead.
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
        // Why: a re-attach landing on the awaits above keeps the id but re-points the pane.
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
  const deliveryRunId = workerMailbox.runId ?? ORCHESTRATION_LEGACY_RUN_ID
  let acknowledged
  try {
    acknowledged = params.ack
      ? db.acknowledgeMailboxDelivery({
          runId: deliveryRunId,
          mailboxHandle: address,
          consumerGeneration: workerMailbox.generation,
          deliveryId: params.ack
        })
      : undefined
  } catch (error) {
    throw asDispatchFence(error)
  }
  const showAll = params.all === true || (params.unread === false && params.peek !== true)
  const readPeek = () => db.getUnreadMessages(address, typeFilter)
  const readDelivery = (wakeTypes?: MessageType[]) => {
    // Why: re-read live, or a re-attach landing on an await above mints a Delivery at a generation
    // the row has already left, which then fences the legitimate worker on every later check.
    if (readCurrentGeneration() !== workerMailbox.generation) {
      throw dispatchFenced()
    }
    try {
      return db.getOrCreateMailboxDelivery({
        runId: deliveryRunId,
        mailboxHandle: address,
        consumerGeneration: workerMailbox.generation,
        wakeTypes
      })
    } catch (error) {
      throw asDispatchFence(error)
    }
  }
  if (showAll) {
    const messages = db.getAllMessagesForHandle(address, 100, typeFilter)
    return {
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages: exposeMessages(messages),
      count: messages.length,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...(params.format || params.inject
        ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
        : {})
    }
  }
  if (params.peek) {
    const messages = readPeek()
    if (messages.length > 0 || !params.wait) {
      return {
        ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
        dispatchId: workerMailbox.dispatchId,
        messages: exposeMessages(messages),
        count: messages.length,
        acknowledged: acknowledged?.delivery.id ?? null,
        ...(params.format || params.inject
          ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
          : {})
      }
    }
  } else {
    const current = readDelivery(params.wait ? typeFilter : undefined)
    if (current || !params.wait) {
      return {
        ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
        dispatchId: workerMailbox.dispatchId,
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
  const waitResult = await runtime.waitForMessage(address, {
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
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages: [],
      count: 0,
      acknowledged: acknowledged?.delivery.id ?? null,
      timedOut: waitResult === 'timed_out',
      cancelled: waitResult === 'cancelled',
      connectionLost: waitResult === 'cancelled' && signal?.aborted === true
    }
  }
  if (params.peek) {
    const arrived = readPeek()
    return {
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages: exposeMessages(arrived),
      count: arrived.length,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...(params.format || params.inject
        ? { formatted: arrived.map(formatMessageBanner).join('\n\n') }
        : {})
    }
  }
  const arrived = readDelivery(typeFilter)
  return {
    ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
    dispatchId: workerMailbox.dispatchId,
    deliveryId: arrived?.delivery.id ?? null,
    messages: exposeMessages(arrived?.messages ?? []),
    count: arrived?.messages.length ?? 0,
    replayed: arrived?.replayed ?? false,
    acknowledged: acknowledged?.delivery.id ?? null,
    ...(params.format || params.inject
      ? { formatted: arrived?.messages.map(formatMessageBanner).join('\n\n') ?? '' }
      : {})
  }
}
