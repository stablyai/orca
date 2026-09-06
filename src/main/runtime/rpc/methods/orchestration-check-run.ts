import type { MessageRow, MessageType, OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../orchestration/formatter'
import { interruptedAcknowledgedCheck } from './orchestration-routing'
import { routeAllMailboxPages } from './orchestration-schemas'
import { resolveRunScope } from './orchestration-run-scope'
import type { CheckParams } from './orchestration-schemas'
import type { z } from 'zod'

type CheckParamsInput = z.infer<typeof CheckParams>

export async function checkRunMailbox(args: {
  params: CheckParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
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
    typeFilter,
    signal,
    legacyCoordinatorRunId,
    revalidateLegacyCoordinator,
    orchestrationCompatibilityEvidence,
    recordMutationReceipt
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
  revalidateLegacyCoordinator?.()
  const currentRun = resolveRunScope(runtime, {
    runId: run.id,
    callerTerminalHandle: handle,
    callerPaneKey: paneKey,
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

  const acknowledged = params.ack
    ? db.acknowledgeRunDelivery({
        runId: run.id,
        consumerGeneration: generation,
        deliveryId: params.ack
      })
    : undefined
  if (acknowledged) {
    recordMutationReceipt?.(
      interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'outcome_unknown')
    )
  }
  if (params.all || (params.unread === false && !params.peek)) {
    const messages = db.getRunMailboxHistory(run.id, 100, typeFilter)
    const result = {
      messages,
      count: messages.length,
      acknowledged: acknowledged?.delivery.id ?? null
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
    messages,
    count: messages.length,
    acknowledged: acknowledged?.delivery.id ?? null,
    ...(params.format || params.inject
      ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
      : {})
  })
  const readPeek = () => db.getUnreadRunMailbox(run.id, 100, typeFilter)
  const readDelivery = (wakeTypes?: MessageType[]) =>
    db.getOrCreateRunDelivery({ runId: run.id, consumerGeneration: generation, wakeTypes })
  let peeked = params.peek ? readPeek() : []
  if (params.peek && peeked.length > 0) {
    return peekResult(peeked)
  }
  let current = params.peek ? undefined : readDelivery(params.wait ? typeFilter : undefined)
  if (current) {
    return {
      runId: run.id,
      deliveryId: current.delivery.id,
      messages: current.messages,
      count: current.messages.length,
      replayed: current.replayed,
      acknowledged: acknowledged?.delivery.id ?? null,
      timedOut: false,
      cancelled: false,
      connectionLost: false,
      ...(params.format || params.inject
        ? { formatted: current.messages.map(formatMessageBanner).join('\n\n') }
        : {})
    }
  }
  if (!params.wait) {
    if (params.peek) {
      return peekResult([])
    }
    return {
      runId: run.id,
      deliveryId: null,
      messages: [],
      count: 0,
      acknowledged: acknowledged?.delivery.id ?? null,
      timedOut: false,
      cancelled: false,
      connectionLost: false
    }
  }

  const waitResult = await runtime.waitForMessage(address, {
    typeFilter: typeFilter as string[] | undefined,
    timeoutMs: params.timeoutMs ?? undefined,
    signal,
    exclusive: true
  })
  try {
    revalidateLegacyCoordinator?.()
  } catch (error) {
    if (!acknowledged) {
      throw error
    }
    return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'consumer_fenced')
  }
  const latestRun = db.getRun(run.id)
  if (!latestRun || latestRun.consumer_generation !== generation) {
    if (acknowledged) {
      return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'consumer_fenced')
    }
    throw new OrchestrationError(
      'consumer_fenced',
      'This mailbox consumer was replaced while waiting.'
    )
  }
  if (waitResult === 'waiter_exists') {
    if (acknowledged) {
      return interruptedAcknowledgedCheck(run.id, acknowledged.delivery.id, 'waiter_exists')
    }
    throw new OrchestrationError(
      'waiter_exists',
      `Run ${run.id} already has an active actionable waiter.`
    )
  }
  if (waitResult === 'timed_out') {
    if (params.peek) {
      return { ...peekResult([]), timedOut: true, cancelled: false, connectionLost: false }
    }
    return {
      runId: run.id,
      deliveryId: null,
      messages: [],
      count: 0,
      acknowledged: acknowledged?.delivery.id ?? null,
      timedOut: true,
      cancelled: false,
      connectionLost: false
    }
  }
  if (waitResult === 'cancelled') {
    if (params.peek) {
      return {
        ...peekResult([]),
        timedOut: false,
        cancelled: true,
        connectionLost: signal?.aborted === true
      }
    }
    return {
      runId: run.id,
      deliveryId: null,
      messages: [],
      count: 0,
      acknowledged: acknowledged?.delivery.id ?? null,
      timedOut: false,
      cancelled: true,
      connectionLost: signal?.aborted === true
    }
  }
  if (params.peek) {
    peeked = readPeek()
    return { ...peekResult(peeked), timedOut: false, cancelled: false, connectionLost: false }
  }
  current = readDelivery(typeFilter)
  return {
    runId: run.id,
    deliveryId: current?.delivery.id ?? null,
    messages: current?.messages ?? [],
    count: current?.messages.length ?? 0,
    replayed: current?.replayed ?? false,
    acknowledged: acknowledged?.delivery.id ?? null,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    ...(params.format && current
      ? { formatted: current.messages.map(formatMessageBanner).join('\n\n') }
      : {})
  }
}
