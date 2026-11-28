import {
  CrewSubscribeParams,
  WorkerApprovalsSubscribeParams,
  WorkerApprovalsUnsubscribeParams
} from '../../../../../shared/orchestration/orchestration-crew'
import { subscribeCrew } from '../../../orchestration/crew/crew-stream'
import type { RpcContext } from '../../core'
import {
  defineOrchestrationMethod,
  defineOrchestrationStreamingMethod
} from './access/orchestration-method-access'

let sequence = 0
/** Run a stream until its client leaves; `start` returns the stream's stop. */
async function streamUntilClosed(
  kind: string,
  { runtime, signal, connectionId, requestId }: RpcContext,
  emitEnd: () => void,
  start: () => () => void
): Promise<void> {
  if (signal?.aborted) {
    return
  }
  // Register before awaits so an unsubscribe arriving during setup cancels before `start()` runs.
  const key = `${kind}:${connectionId ?? 'local'}:${++sequence}`
  let released = false
  let stop: (() => void) | null = null
  let finish: (() => void) | null = null
  let endOnRelease = true
  const release = () => runtime.cleanupSubscription(key)
  runtime.registerSubscriptionCleanup(
    key,
    () => {
      if (released) {
        return
      }
      released = true
      stop?.()
      stop = null
      signal?.removeEventListener('abort', release)
      if (endOnRelease) {
        emitEnd()
      }
      finish?.()
    },
    connectionId,
    // Lets a client on a shared socket end this one stream by its request id.
    requestId
  )
  signal?.addEventListener('abort', release, { once: true })
  if (signal?.aborted) {
    release()
    return
  }
  try {
    await runtime.openAgentSessionRecordStore()
  } catch (error) {
    if (released) {
      return
    }
    endOnRelease = false
    release()
    throw error
  }
  if (released || signal?.aborted) {
    release()
    return
  }
  await new Promise<void>((resolve) => {
    finish = resolve
    try {
      stop = start()
    } catch (error) {
      endOnRelease = false
      release()
      throw error
    }
    if (released || signal?.aborted) {
      release()
    }
  })
}

export const ORCHESTRATION_CREW_METHODS = [
  defineOrchestrationStreamingMethod({
    name: 'orchestration.crewSubscribe',
    access: { kind: 'localOnly', targets: { party: 'party' } },
    permission: 'workspace',
    params: CrewSubscribeParams,
    handler: ({ party, view, deltas }, context, emit) =>
      streamUntilClosed(
        'crew',
        context,
        () => emit({ type: 'end' }),
        () =>
          subscribeCrew(
            () => context.runtime.getOrchestrationCrewSnapshot(party),
            context.runtime.watchOrchestrationCrew(party),
            emit,
            view,
            deltas
          )
      )
  }),
  defineOrchestrationStreamingMethod({
    name: 'orchestration.workerApprovalsSubscribe',
    access: { kind: 'localOnly', targets: { party: 'party' } },
    permission: 'workspace',
    params: WorkerApprovalsSubscribeParams,
    handler: ({ party }, context, emit) =>
      streamUntilClosed(
        'worker-approvals',
        context,
        () => emit({ type: 'end' }),
        () => context.runtime.subscribeOrchestrationWorkerApprovals(party, emit)
      )
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerApprovalsUnsubscribe',
    access: { kind: 'localOnly', targets: {} },
    permission: 'workspace',
    params: WorkerApprovalsUnsubscribeParams,
    handler: ({ subscriptionId }, { runtime, connectionId }) => {
      runtime.releaseSubscriptionByRequest(connectionId, subscriptionId)
      return { unsubscribed: true }
    }
  })
]
