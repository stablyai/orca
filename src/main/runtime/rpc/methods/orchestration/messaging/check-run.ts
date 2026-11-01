import type { MessageRow, MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { MailboxDeliveryBatch } from '../../../../orchestration/db/messages/role-mailbox-delivery'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcContext } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/formatter'
import { deliveryReceipt, exposeMessages, handsOverBatch } from './mailbox-message-receipt'
import { interruptedAcknowledgedCheck } from '../routing'
import { routeAllMailboxPages } from '../schemas'
import { resolveRunScope } from '../runs/run-scope'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { checkRunPendingMail } from './check-run-pending-mail'

type CheckParamsInput = z.infer<typeof CheckParams>

export async function checkRunMailbox(args: {
  params: CheckParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
  callerSession: OrchestrationSessionCaller | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  legacyCoordinatorRunId: string | undefined
  revalidateLegacyCoordinator: (() => string) | undefined
  orchestrationCompatibilityEvidence: RpcContext['orchestrationCompatibilityEvidence']
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): Promise<unknown> {
  const {
    params,
    runtime,
    db,
    handle,
    paneKey,
    callerSession,
    typeFilter,
    signal,
    legacyCoordinatorRunId,
    revalidateLegacyCoordinator,
    orchestrationCompatibilityEvidence
  } = args
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
  const run = resolveRunScope(runtime, {
    runId: params.run,
    callerTerminalHandle: handle,
    callerPaneKey: paneKey,
    callerSession,
    requireCurrentConsumer: true,
    legacyCoordinatorRunId,
    callerEvidence: orchestrationCompatibilityEvidence
  })
  const generation = run.consumer_generation
  const address = `run:${run.id}`
  runtime.ensureOrchestrationFederationRelay(run.id)
  await routeDirectSnapshot(run.id, handle, (throughSequence) =>
    db.routeUnreadDirectMessagesToRunMailbox(run.id, handle, throughSequence)
  )
  const coordinatorHandle = run.coordinator_handle
  if (coordinatorHandle && coordinatorHandle !== handle) {
    await routeDirectSnapshot(run.id, coordinatorHandle, (throughSequence) =>
      db.routeUnreadDirectMessagesToRunMailbox(run.id, coordinatorHandle, throughSequence)
    )
  }
  const revalidateConsumer = (): void => {
    revalidateLegacyCoordinator?.()
    const currentRun = resolveRunScope(runtime, {
      runId: run.id,
      callerTerminalHandle: handle,
      callerPaneKey: paneKey,
      callerSession,
      requireCurrentConsumer: true,
      legacyCoordinatorRunId,
      callerEvidence: orchestrationCompatibilityEvidence
    })
    if (currentRun.consumer_generation !== generation) {
      throw new OrchestrationError(
        'consumer_fenced',
        'This mailbox consumer was replaced while routing pending mail.'
      )
    }
  }
  revalidateConsumer()

  const pending = await checkRunPendingMail({ ...args, run, revalidateConsumer })
  if (handsOverBatch(pending.result)) {
    return pending.result
  }
  try {
    revalidateConsumer()
  } catch (error) {
    if (pending.acknowledged) {
      return interruptedAcknowledgedCheck(run.id, pending.acknowledged, 'consumer_fenced')
    }
    throw error
  }
  if (pending.result) {
    return pending.result
  }
  const acknowledged = pending.acknowledged
  if (params.all || (params.unread === false && !params.peek)) {
    const messages = db.getRunMailboxHistory(run.id, 100, typeFilter)
    const result = {
      messages: exposeMessages(messages),
      count: messages.length,
      acknowledged: acknowledged ?? null
    }
    if (params.format || params.inject) {
      return {
        ...result,
        formatted: messages.map(formatMessageBanner).join('\n\n'),
        runId: run.id
      }
    }
    return { ...result, runId: run.id }
  }

  const peekResult = (messages: MessageRow[]) => ({
    runId: run.id,
    messages: exposeMessages(messages),
    count: messages.length,
    acknowledged: acknowledged ?? null,
    ...(params.format || params.inject
      ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
      : {})
  })
  const readPeek = () => db.getUnreadRunMailbox(run.id, 100, typeFilter)
  const result = (batch: MailboxDeliveryBatch | undefined) =>
    deliveryReceipt({
      mailbox: { runId: run.id },
      batch,
      acknowledged,
      format: params.format === true || params.inject === true
    })
  // The receipt commits with the take, so --retry-request can always replay a handed-over batch.
  const takeDelivery = (wakeTypes?: MessageType[]) =>
    db.takeRunDelivery({
      runId: run.id,
      consumerGeneration: generation,
      wakeTypes,
      recordTaken: (taken) => args.recordMutationReceipt?.(result(taken))
    })
  if (params.peek) {
    const peeked = readPeek()
    if (peeked.length > 0 || !params.wait) {
      return peekResult(peeked)
    }
  } else {
    const current = takeDelivery(params.wait ? typeFilter : undefined)
    if (current || !params.wait) {
      return result(current)
    }
  }

  const waitResult = await runtime.waitForMessage(address, {
    typeFilter: typeFilter as string[] | undefined,
    timeoutMs: params.timeoutMs ?? undefined,
    signal
  })
  try {
    revalidateConsumer()
  } catch (error) {
    if (!acknowledged) {
      throw error
    }
    return interruptedAcknowledgedCheck(run.id, acknowledged, 'consumer_fenced')
  }
  const latestRun = db.getRun(run.id)
  if (!latestRun || latestRun.consumer_generation !== generation) {
    if (acknowledged) {
      return interruptedAcknowledgedCheck(run.id, acknowledged, 'consumer_fenced')
    }
    throw new OrchestrationError(
      'consumer_fenced',
      'This mailbox consumer was replaced while waiting.'
    )
  }
  if (waitResult === 'timed_out' || waitResult === 'cancelled') {
    const ended = {
      timedOut: waitResult === 'timed_out',
      cancelled: waitResult === 'cancelled',
      connectionLost: waitResult === 'cancelled' && signal?.aborted === true
    }
    return params.peek ? { ...peekResult([]), ...ended } : { ...result(undefined), ...ended }
  }
  if (params.peek) {
    return { ...peekResult(readPeek()), timedOut: false, cancelled: false, connectionLost: false }
  }
  const batch = waitResult.share(`${address}:${generation}`, () => takeDelivery(typeFilter))
  // A waiter that shares another's take has no take transaction, so it receipts the batch on arrival.
  args.recordMutationReceipt?.(result(batch))
  return result(batch)
}
