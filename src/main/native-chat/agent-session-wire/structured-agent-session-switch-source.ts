import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionLeasePossiblyWriting } from '../../../shared/agent-session-lease-adjudication'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import {
  catchUpSwitchedCliTranscript,
  type SwitchStoppedCliTurn,
  type SwitchTranscriptSource
} from './structured-agent-session-switch-import'
import { catchUpStructuredSessionAtRest } from './structured-agent-session-at-rest-catch-up'
import type * as HostTypes from './structured-agent-session-host-types'
import type { AgentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
type SwitchSourceContext = Pick<
  StructuredAgentSessionHost,
  'deps' | 'cancel' | 'switchGeneration' | 'guardSwitchWork' | 'currentWork'
> & {
  now: () => number
  startFlights: Pick<StructuredAgentSessionStartFlights, 'physicalExit'>
  lifetime: Pick<StructuredAgentSessionConversationLifetime, 'conversation' | 'stopAgent'>
  sessions: StructuredAgentSessionConversationLifetimeHost['sessions']
  serialize: StructuredAgentSessionConversationLifetimeHost['serialize']
  subscribers: {
    publish: (
      sessionId: string,
      journal: HostTypes.StructuredAgentSessionHostSession['journal']
    ) => void
  }
}
export function structuredAgentSessionSwitchSource(context: SwitchSourceContext) {
  return {
    captureSwitchWork: (id: string, deadline: AgentSessionSwitchDeadline) => {
      const count = context.deps.store.admittedSendCount(id)
      const command = context.switchGeneration(id)
      return () =>
        !deadline.signal.aborted &&
        deadline.remaining() > 0 &&
        context.deps.store.admittedSendCount(id) === count &&
        context.switchGeneration(id) === command
    },
    stopForSwitch: async (
      sessionId: string,
      caller: HostTypes.StructuredAgentSessionCaller,
      deadline: AgentSessionSwitchDeadline
    ) => {
      deadline.check()
      const conversation = await context.lifetime.conversation(sessionId)
      deadline.check()
      let child = context.sessions.get(sessionId)?.child ?? null
      let admitted = context.deps.store.admittedSendCount(sessionId)
      let accepted = false
      const command = context.switchGeneration(sessionId)
      const workCurrent = () =>
        !deadline.signal.aborted &&
        deadline.remaining() > 0 &&
        context.deps.store.admittedSendCount(sessionId) === admitted &&
        context.switchGeneration(sessionId) === command
      context.guardSwitchWork(sessionId, workCurrent)
      const record = context.deps.store.getRecord(sessionId)
      if (!record) {
        throw agentSessionRefusalError('agent_session_identity_required', {
          reason: 'recordMissing'
        })
      }
      let settleWorker: ((proven: boolean) => void) | undefined
      try {
        settleWorker = context.deps.captureSessionSwitchStop?.(sessionId)
      } catch {
        context.deps.logger.warn('capturing worker Stop failed', {
          scope: 'session-switch',
          sessionId
        })
      }
      // A Stop with no turn running and nothing queued stops nothing (the common pattern makes it a
      // no-op, so no Stop note is written); the process stop below still ends the agent with proof.
      const work = context.currentWork(sessionId, conversation.journal)
      const stops =
        work === undefined ||
        work.working() ||
        conversation.journal.submissions().some(isQueuedAgentJournalSubmission)
      let proven = false
      try {
        const answer = !stops
          ? ({ ok: true } as const)
          : await context.cancel(caller, {
              envelope: {
                sessionId,
                clientOperationId: createStructuredAgentSessionOperationId(
                  randomUUID,
                  context.now()
                ),
                expectedRuntimeFence: record.lease.runtimeFence,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.cancel',
                  sessionId,
                  fields: {}
                })
              },
              onAccepted: (captured) => {
                child = captured
                admitted = context.deps.store.admittedSendCount(sessionId)
                accepted = true
              },
              waitForShutdown: true
            })
        if (!answer.ok) {
          throw new AgentSessionRefusalError(answer.refusal)
        }
        const source = await context.serialize(sessionId, async () => {
          deadline.check()
          const current = context.sessions.get(sessionId)?.child
          if (
            context.deps.store.admittedSendCount(sessionId) !== admitted ||
            context.switchGeneration(sessionId) !== command ||
            (current && current !== child)
          ) {
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'messagesUnsettled'
            })
          }
          if (current) {
            try {
              await context.lifetime.stopAgent(
                sessionId,
                accepted ? { recorded: 'user-stop' } : { cause: 'user-close' }
              )
            } catch {
              context.deps.logger.warn('switch source exit was not confirmed', {
                scope: 'session-switch',
                sessionId,
                source: 'chat',
                exactChild: true
              })
              throw agentSessionRefusalError('agent_session_ownership_unknown', {
                reason: 'ownerUnproven'
              })
            }
          }
          const lease = context.deps.store.getRecord(sessionId)?.lease
          if (!lease || agentSessionLeasePossiblyWriting(lease)) {
            throw agentSessionRefusalError('agent_session_ownership_unknown', {
              reason: 'ownerUnproven'
            })
          }
          const physical = context.startFlights.physicalExit(
            sessionId,
            lease.deathEvidence?.kind === 'kill-delivered'
          )
          return { physical }
        })
        // Source completion cannot occupy the serializer or the destination-work barrier.
        for (;;) {
          await deadline.wait(source.physical.wait(deadline.signal))
          const complete = await context.serialize(sessionId, async () => {
            deadline.check()
            const current = context.sessions.get(sessionId)?.child
            if (
              context.deps.store.admittedSendCount(sessionId) !== admitted ||
              context.switchGeneration(sessionId) !== command ||
              (current && current !== child)
            ) {
              throw agentSessionRefusalError('agent_session_operation_invalid', {
                reason: 'messagesUnsettled'
              })
            }
            const lease = context.deps.store.getRecord(sessionId)?.lease
            if (!lease || agentSessionLeasePossiblyWriting(lease)) {
              throw agentSessionRefusalError('agent_session_ownership_unknown', {
                reason: 'ownerUnproven'
              })
            }
            return source.physical.current()
          })
          if (complete) {
            break
          }
        }
        proven = true
        return () => workCurrent() && source.physical.current()
      } finally {
        try {
          settleWorker?.(proven)
        } catch {
          context.deps.logger.warn('settling worker Stop failed', {
            scope: 'session-switch',
            sessionId,
            proven
          })
        }
      }
    },
    refreshSwitchTranscript: async (
      sessionId: string,
      source: Omit<SwitchTranscriptSource, 'agent'> & {
        agent?: SwitchTranscriptSource['agent']
      },
      deadline: AgentSessionSwitchDeadline,
      stopped?: SwitchStoppedCliTurn,
      check: () => void = deadline.check,
      settleAbandoned = false
    ) => {
      const session = await context.lifetime.conversation(sessionId)
      const transcript = { ...source, agent: source.agent ?? session.params.agent }
      if (transcript.agent === 'codex') {
        await catchUpStructuredSessionAtRest({
          journal: session.journal,
          threadId: source.sessionId,
          filePath: source.filePath,
          fence: context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0,
          deadline,
          stoppedTurnId: stopped?.turnId,
          stoppedUserItemKey: stopped?.userItemKey,
          settleAbandoned,
          check
        })
      }
      await catchUpSwitchedCliTranscript({
        journal: session.journal,
        source: transcript,
        resumeCursor: agentSessionProviderHandleChainHead(
          context.deps.store.getRecord(sessionId)?.providerHandleChain ?? []
        )?.handle.resumeCursor,
        fence: context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0,
        deadline,
        stopped,
        settleAbandoned,
        check
      })
      context.subscribers.publish(sessionId, session.journal)
    }
  }
}
