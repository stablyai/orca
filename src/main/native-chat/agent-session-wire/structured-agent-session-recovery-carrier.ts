import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  deriveContextTransferState,
  type ContextTransferState
} from '../agent-session-journal/context-transfer-state'
import { RecoveryContextBudgetError } from '../agent-session-context-transfer-text'
import {
  cancelledDispatch,
  StructuredAgentSessionInputNotAdmitted
} from './structured-agent-session-input-admission'
import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import { prepareRecoveryDelivery } from './structured-agent-session-recovery-delivery'
import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandleChain
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { classifyNativeChatSend } from '../../../shared/native-chat/input/native-chat-slash-commands'

/** One preparation per actual target; the pending callback co-commits first-input and inline facts. */
export function prepareRecoveryCarrier(
  ctx: AgentSessionHandoverContext,
  submission: AgentJournalSubmission,
  input: AgentJournalMessageItem
) {
  const { clientMessageId } = submission
  const chain = ctx.record()?.providerHandleChain ?? []
  const state = deriveContextTransferState(ctx.journal.contextTransfers.read(), chain)
  // A typed agent command goes as typed, like Compact; the next ordinary input carries the context.
  const required =
    state.kind !== 'none' &&
    state.kind !== 'settled' &&
    !((state.kind === 'owed' || state.kind === 'uncertain') && typedAgentCommand(ctx, chain, input))
  return {
    required,
    async run(
      body: AgentJournalMessageItem,
      commit: (run: () => Promise<void>) => Promise<void>,
      isCurrent: () => boolean,
      pending: () => Promise<void>,
      signal?: AbortSignal
    ): Promise<AgentJournalMessageItem> {
      if (!required) {
        return body
      }
      try {
        const delivered = await prepareRecoveryDelivery(
          ctx,
          clientMessageId,
          body,
          state,
          signal
        ).beforeCarrier(commit, isCurrent)
        await commit(async () => {
          signal?.throwIfAborted()
          if (!isCurrent()) {
            throw new Error('Context carrier lost its provider child')
          }
          await pending()
        })
        return delivered
      } catch (error) {
        if (error instanceof StructuredAgentSessionInputNotAdmitted) {
          throw error
        }
        if (signal?.aborted) {
          throw new StructuredAgentSessionInputNotAdmitted(
            cancelledDispatch(submission.queuedMessageId !== undefined)
          )
        }
        throw new StructuredAgentSessionInputNotAdmitted({
          state: 'rejected',
          ...agentSessionFailureWords(
            agentSessionFailureFact(
              error instanceof RecoveryContextBudgetError
                ? 'historyTooLarge'
                : historyWriteUncertain(ctx, state)
                  ? 'notDelivered'
                  : 'hostFault',
              { neverReachedAgent: true }
            ),
            { ...ctx.failureTextContext, surface: 'rejection' }
          )
        })
      }
    }
  }
}

/** A started history write without proof leaves the input unsent, but the next send needs a fresh target. */
function historyWriteUncertain(ctx: AgentSessionHandoverContext, prepared: ContextTransferState) {
  try {
    const current = deriveContextTransferState(
      ctx.journal.contextTransfers.read(),
      ctx.record()?.providerHandleChain ?? []
    )
    return (
      current.kind === 'uncertain' &&
      prepared.kind !== 'none' &&
      current.target.id === prepared.target.id
    )
  } catch {
    return false
  }
}

/** Pi and ACP agents run a line-leading `/command` they advertise; with no list, any leading slash. */
function typedAgentCommand(
  ctx: AgentSessionHandoverContext,
  chain: AgentSessionProviderHandleChain,
  input: AgentJournalMessageItem
): boolean {
  const transport = agentSessionProviderHandleChainHead(chain)?.handle.transport
  if (transport !== 'acp' && transport !== 'jsonl-rpc') {
    return false
  }
  const advertised = ctx.adapter.readCommands?.(ctx.sessionId)
  const kind = classifyNativeChatSend(
    input.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    advertised ?? [],
    null,
    null
  )
  return kind === 'command' || (advertised === undefined && kind === 'unknown-token')
}
