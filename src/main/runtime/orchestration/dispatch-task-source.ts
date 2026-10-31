import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import {
  agentMessageSender,
  withSenderIdentity,
  type SenderSnapshotResolver
} from './agent-message-sender'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow } from './types'

/** Task provenance shown in worker chat: coordinator identity and the joined task records. */
export function dispatchTaskSource(args: {
  db: OrchestrationDb
  dispatch: Pick<DispatchContextRow, 'id' | 'run_id' | 'task_id'>
  /** The coordinator's address; a Dispatch with no declared caller names no sender. */
  from: string | undefined
  senderSnapshot: SenderSnapshotResolver
}): AgentMessageSource {
  const { dispatch } = args
  return {
    kind: 'agent',
    senders: args.from
      ? [
          withSenderIdentity(
            {
              ...agentMessageSender(args.from, args.db, args.senderSnapshot),
              relation: 'coordinator'
            },
            args.db.getAgentSenderIdentity(`creator:${dispatch.id}`)
          )
        ]
      : [],
    orchestration: {
      message: 'task',
      runId: dispatch.run_id,
      taskId: dispatch.task_id,
      dispatchId: dispatch.id
    }
  }
}
