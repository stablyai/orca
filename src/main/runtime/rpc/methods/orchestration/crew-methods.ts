import {
  CrewSubscribeParams,
  WorkerApprovalsSubscribeParams
} from '../../../../../shared/orchestration/orchestration-crew'
import { subscribeCrew } from '../../../orchestration/crew/crew-stream'
import type { RpcContext } from '../../core'
import { defineOrchestrationStreamingMethod } from './access/orchestration-method-access'

let sequence = 0
/** Run a stream until its client leaves; `start` returns the stream's stop. */
async function streamUntilClosed(
  kind: string,
  { runtime, signal, connectionId }: RpcContext,
  emitEnd: () => void,
  start: () => () => void
): Promise<void> {
  if (signal?.aborted) {
    return
  }
  await runtime.openAgentSessionRecordStore()
  if (signal?.aborted) {
    return
  }
  await new Promise<void>((resolve) => {
    const key = `${kind}:${connectionId ?? 'local'}:${++sequence}`
    const release = () => runtime.cleanupSubscription(key)
    const stop = start()
    runtime.registerSubscriptionCleanup(
      key,
      () => {
        stop()
        signal?.removeEventListener('abort', release)
        emitEnd()
        resolve()
      },
      connectionId
    )
    signal?.addEventListener('abort', release, { once: true })
    if (signal?.aborted) {
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
    handler: ({ party }, context, emit) =>
      streamUntilClosed(
        'crew',
        context,
        () => emit({ type: 'end' }),
        () =>
          subscribeCrew(
            () => context.runtime.getOrchestrationCrewSnapshot(party),
            context.runtime.watchOrchestrationCrew,
            emit
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
  })
]
