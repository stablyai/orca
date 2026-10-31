import { CrewSubscribeParams } from '../../../../../shared/orchestration-crew'
import { subscribeCrew } from '../../../orchestration/crew/crew-stream'
import { defineStreamingMethod } from '../../core'

let sequence = 0
export const ORCHESTRATION_CREW_METHODS = [
  defineStreamingMethod({
    name: 'orchestration.crewSubscribe',
    permission: 'workspace',
    params: CrewSubscribeParams,
    handler: async ({ party }, { runtime, signal, connectionId }, emit) => {
      if (signal?.aborted) {
        return
      }
      await runtime.openAgentSessionRecordStore()
      if (signal?.aborted) {
        return
      }
      await new Promise<void>((resolve) => {
        const key = `crew:${connectionId ?? 'local'}:${++sequence}`
        const release = () => runtime.cleanupSubscription(key)
        const stop = subscribeCrew(
          () => runtime.getOrchestrationCrewSnapshot(party),
          runtime.watchOrchestrationCrew,
          emit
        )
        runtime.registerSubscriptionCleanup(
          key,
          () => {
            stop()
            signal?.removeEventListener('abort', release)
            emit({ type: 'end' })
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
  })
]
