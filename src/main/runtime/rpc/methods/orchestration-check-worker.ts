import type { MessageType, OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../orchestration/formatter'
import { routeAllMailboxPages } from './orchestration-schemas'
import type { CheckParams } from './orchestration-schemas'
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
    ? { dispatchId: activeDispatch.id, runId: activeDispatch.run_id }
    : remoteAttachment
      ? { dispatchId: remoteAttachment.dispatch_id, runId: undefined }
      : undefined
  if (!workerMailbox) {
    return undefined
  }
  const address = `dispatch:${workerMailbox.dispatchId}`
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
        return
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
  const showAll = params.all === true || (params.unread === false && params.peek !== true)
  const messages = showAll
    ? db.getAllMessagesForHandle(address, 100, typeFilter)
    : db.getUnreadMessages(address, typeFilter)
  if (!showAll && params.peek !== true && messages.length > 0) {
    db.markAsRead(messages.map((message) => message.id))
  }
  if (messages.length > 0 || !params.wait) {
    return {
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages,
      count: messages.length,
      ...(params.format || params.inject
        ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
        : {})
    }
  }
  const waitResult = await runtime.waitForMessage(address, {
    typeFilter: typeFilter as string[] | undefined,
    timeoutMs: params.timeoutMs ?? undefined,
    signal
  })
  await revalidateWorkerMailbox()
  if (waitResult === 'timed_out' || waitResult === 'cancelled') {
    return {
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages: [],
      count: 0,
      timedOut: waitResult === 'timed_out',
      cancelled: waitResult === 'cancelled',
      connectionLost: waitResult === 'cancelled' && signal?.aborted === true
    }
  }
  const arrived = db.getUnreadMessages(address, typeFilter)
  db.markAsRead(arrived.map((message) => message.id))
  return {
    ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
    dispatchId: workerMailbox.dispatchId,
    messages: arrived,
    count: arrived.length,
    ...(params.format || params.inject
      ? { formatted: arrived.map(formatMessageBanner).join('\n\n') }
      : {})
  }
}
