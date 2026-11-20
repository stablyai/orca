import type { ZotzAgentQueueSnapshot } from '../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import type { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'
import type { ZotzMemoryGovernorService } from './zotz-memory-governor-service'

export function buildZotzAgentQueueSnapshot(
  governor: Pick<ZotzMemoryGovernorService, 'getState'>,
  queue: Pick<ZotzAgentLaunchQueue, 'list' | 'listCanceled'>
): ZotzAgentQueueSnapshot {
  const state = governor.getState()
  return {
    memory: state
      ? {
          totalBytes: state.totalBytes,
          availableBytes: state.availableBytes,
          pressure: state.pressure,
          minFreeBytes: state.limits.minFreeBytes,
          perAgentMaxBytes: state.limits.perAgentMaxBytes,
          sampledAt: state.sampledAt
        }
      : null,
    running:
      state?.agents.map(({ paneKey, agent, state, worktreeId, bytes, peakBytes, startedAt }) => ({
        paneKey,
        agent,
        state,
        worktreeId,
        bytes,
        peakBytes,
        startedAt
      })) ?? [],
    done: state?.finished ?? [],
    queued: queue.list().map((task) => ({
      id: task.id,
      agent: task.agent,
      priority: task.priority,
      label: task.label,
      estimatedBytes: task.estimatedBytes,
      enqueuedAt: task.enqueuedAt,
      position: task.position,
      waitReason: task.waitReason
    })),
    canceled: queue.listCanceled().map(({ id, agent, label, canceledAt }) => ({
      id,
      agent,
      label,
      canceledAt
    }))
  }
}
