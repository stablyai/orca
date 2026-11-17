// Binds checkpoints to the host: the capture a send takes, and the host's preview/restore/undo.

import type { StructuredAgentSessionDeliveryLoopDeps } from '../delivery/structured-agent-session-delivery-loop-deps'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import {
  type AgentSessionCheckpoints,
  createAgentSessionCheckpoints
} from './agent-session-checkpoints'

/** The snapshot a send takes before its message opens a turn; never throws. */
export function structuredAgentSessionTurnCheckpoint(
  deps: Pick<
    StructuredAgentSessionDeliveryLoopDeps,
    'record' | 'resolveWorkspacePath' | 'logger' | 'now'
  >,
  sessionId: string
): (itemId: string, signal?: AbortSignal) => Promise<() => void> {
  const { captureTurn } = createAgentSessionCheckpoints({
    record: deps.record,
    ...(deps.resolveWorkspacePath ? { resolveWorkspacePath: deps.resolveWorkspacePath } : {}),
    isBusy: () => false,
    logger: deps.logger,
    now: deps.now
  })
  return (itemId, signal) => captureTurn(sessionId, itemId, signal)
}

type CheckpointHost = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'resolveWorkspacePath' | 'logger' | 'now'>
  readStatusSummary: (sessionId: string) => { status: string | null } | undefined
}
const hostCheckpoints = new WeakMap<CheckpointHost, AgentSessionCheckpoints>()

/** Preview, restore and undo for a host's chats; a restore waits for a running turn to end. */
export function hostAgentSessionCheckpoints(host: CheckpointHost): AgentSessionCheckpoints {
  let checkpoints = hostCheckpoints.get(host)
  if (!checkpoints) {
    const { deps } = host
    checkpoints = createAgentSessionCheckpoints({
      record: (sessionId) => deps.store.getRecord(sessionId),
      ...(deps.resolveWorkspacePath ? { resolveWorkspacePath: deps.resolveWorkspacePath } : {}),
      // Any chat working in the same worktree could be writing the files a restore rewrites.
      isBusy: (sessionId) => {
        const location = deps.store.getRecord(sessionId)?.location
        return deps.store
          .listConversations()
          .some(
            (record) =>
              record.location.workspaceId === location?.workspaceId &&
              record.location.executionHostId === location.executionHostId &&
              host.readStatusSummary(record.sessionId)?.status === 'working'
          )
      },
      logger: deps.logger,
      now: () => deps.now?.() ?? Date.now()
    })
    hostCheckpoints.set(host, checkpoints)
  }
  return checkpoints
}
