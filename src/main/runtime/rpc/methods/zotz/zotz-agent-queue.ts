import { defineMethod, defineStreamingMethod } from '../../core'
import {
  ZotzAgentQueueSnapshotParams,
  ZotzAgentQueueSubscribeParams,
  ZotzAgentQueueTaskParams
} from '../../../../../shared/rpc-contract/zotz/zotz-agent-queue-params'
import {
  EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT,
  type ZotzAgentQueueSnapshot
} from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import { buildZotzAgentQueueSnapshot } from '../../../../zotz/memory-governor/zotz-agent-queue-snapshot-builder'
import { getZotzAgentQueueSource } from '../../../../zotz/memory-governor/zotz-agent-queue-source'

let subscriptionSeq = 0

function readSnapshot(): ZotzAgentQueueSnapshot {
  const source = getZotzAgentQueueSource()
  if (!source) {
    return EMPTY_ZOTZ_AGENT_QUEUE_SNAPSHOT
  }
  // A client opening the board wants current numbers even on an idle node.
  source.governor.wake()
  return buildZotzAgentQueueSnapshot(source.governor, source.queue)
}

export const ZOTZ_AGENT_QUEUE_SNAPSHOT_METHOD = defineMethod({
  name: 'zotz.agentQueue.snapshot',
  permission: 'workspace',
  params: ZotzAgentQueueSnapshotParams,
  handler: async () => readSnapshot()
})

export const ZOTZ_AGENT_QUEUE_SUBSCRIBE_METHOD = defineStreamingMethod({
  name: 'zotz.agentQueue.subscribe',
  permission: 'workspace',
  params: ZotzAgentQueueSubscribeParams,
  handler: async (_params, ctx, emit) => {
    emit(readSnapshot())
    const source = getZotzAgentQueueSource()
    if (!source) {
      return
    }
    await new Promise<void>((resolve) => {
      const publish = (): void => emit(buildZotzAgentQueueSnapshot(source.governor, source.queue))
      const stopQueue = source.queue.subscribe(publish)
      const stopGovernor = source.governor.subscribe(publish)
      let ended = false
      const end = (): void => {
        if (ended) {
          return
        }
        ended = true
        stopQueue()
        stopGovernor()
        ctx.signal?.removeEventListener('abort', end)
        resolve()
      }
      ctx.runtime.registerSubscriptionCleanup(
        `zotz-agent-queue-${ctx.connectionId ?? 'inproc'}-${++subscriptionSeq}`,
        end,
        ctx.connectionId
      )
      if (ctx.signal?.aborted) {
        end()
      } else {
        ctx.signal?.addEventListener('abort', end, { once: true })
      }
    })
  }
})

export const ZOTZ_AGENT_QUEUE_CANCEL_METHOD = defineMethod({
  name: 'zotz.agentQueue.cancel',
  permission: 'workspace',
  params: ZotzAgentQueueTaskParams,
  handler: async ({ id }) => {
    getZotzAgentQueueSource()?.queue.cancel(id)
    return { ok: true }
  }
})

// Starts the launch even though memory says wait; a paired client needs the same permission that opens terminals.
export const ZOTZ_AGENT_QUEUE_FORCE_START_METHOD = defineMethod({
  name: 'zotz.agentQueue.forceStart',
  permission: 'workspace',
  params: ZotzAgentQueueTaskParams,
  handler: async ({ id }) => {
    getZotzAgentQueueSource()?.queue.forceStart(id)
    return { ok: true }
  }
})

export const ZOTZ_AGENT_QUEUE_DISMISS_CANCELED_METHOD = defineMethod({
  name: 'zotz.agentQueue.dismissCanceled',
  permission: 'workspace',
  params: ZotzAgentQueueTaskParams,
  handler: async ({ id }) => {
    getZotzAgentQueueSource()?.queue.dismissCanceled(id)
    return { ok: true }
  }
})

export const ZOTZ_AGENT_QUEUE_METHODS = [
  ZOTZ_AGENT_QUEUE_SNAPSHOT_METHOD,
  ZOTZ_AGENT_QUEUE_SUBSCRIBE_METHOD,
  ZOTZ_AGENT_QUEUE_CANCEL_METHOD,
  ZOTZ_AGENT_QUEUE_FORCE_START_METHOD,
  ZOTZ_AGENT_QUEUE_DISMISS_CANCELED_METHOD
]
