import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  latestStructuredAgentSessionRequest,
  latestStructuredAgentSessionUserItem
} from '../../../shared/structured-agent-session-latest-request'
import { codexTransientTurnError } from '../../codex/codex-transient-turn-error'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { StructuredAgentSessionTransientRecovery } from './structured-agent-session-transient-recovery'

export const TRANSIENT_RECOVERY_CALLER = 'trusted-local:transient-error-continuation'
export const TRANSIENT_RECOVERY_MESSAGE =
  'Continue the previous task. Orca sent this automatically after a temporary provider error. Check the last action and its result before repeating any work.'

/** Runs on the execution host, so hidden chats and paired clients share exactly one retry budget. */
export function wireTransientRecovery(
  host: StructuredAgentSessionHost,
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
): StructuredAgentSessionTransientRecovery {
  const recovery = new StructuredAgentSessionTransientRecovery({
    now: host.deps.now,
    enabled: () => host.deps.transientRecovery?.enabled() === true,
    onDisabled: host.deps.transientRecovery?.onDisabled,
    snapshot: (sessionId) => {
      const session = sessions.get(sessionId)
      const record = host.deps.store.getRecord(sessionId)
      if (
        !session ||
        !record ||
        record.provider !== 'codex' ||
        session.child?.close ||
        host.deps.hasOpenDispatch?.(record)
      ) {
        return null
      }
      const { items } = session.journal.snapshot()
      const request = latestStructuredAgentSessionRequest(items, session.journal.submissions())
      if (request?.kind !== 'turn' || request.turnState === 'running') {
        return null
      }
      return {
        turnId: request.id,
        fence: record.lease.runtimeFence,
        ...session.journal.cursor(),
        userItemId: latestStructuredAgentSessionUserItem(items)?.itemId ?? null,
        error: codexTransientTurnError(items, request.id)
      }
    },
    send: async (sessionId, operationId, beforeRun) => {
      const record = host.deps.store.getRecord(sessionId)
      if (!record) {
        return false
      }
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: TRANSIENT_RECOVERY_MESSAGE }]
      }
      const result = await host.send(
        { callerKey: TRANSIENT_RECOVERY_CALLER },
        {
          body,
          beforeRun,
          envelope: {
            sessionId,
            clientOperationId: operationId,
            expectedRuntimeFence: record.lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId,
              fields: { body }
            })
          }
        }
      )
      return result.ok
    },
    logger: host.deps.logger
  })
  host.subscribeTurnCompletions({
    id: 'host-transient-error-recovery',
    emit: (event) => {
      if (event.type === 'completion' && !event.completion.awaitingUser) {
        const { sessionId, turnId, outcome } = event.completion
        recovery.completed(sessionId, turnId, outcome)
      }
    }
  })
  return recovery
}
