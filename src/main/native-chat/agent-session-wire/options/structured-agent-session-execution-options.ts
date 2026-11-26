import {
  readAgentSessionExecutionOptions,
  type AgentSessionExecutionOptions
} from '../../../../shared/agent-session/options/protocol/agent-session-execution-options'
import {
  refuse,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { unpickedFastModeIsOff } from '../../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import type { AgentSessionTurnContext } from '../operations/structured-agent-session-turns'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-option-intent'

/** Capture send-specific choices or saved defaults once under the acceptance lane. */
export function captureStructuredExecutionOptions(
  ctx: Pick<AgentSessionTurnContext, 'agents' | 'agent' | 'persistedOptions'>,
  supplied?: Readonly<Record<string, string>>,
  selection?: Readonly<Record<string, string>>
): { options: AgentSessionExecutionOptions } | { refusal: AgentSessionWireRefusal } {
  const saved = ctx.persistedOptions ?? {}
  const candidate: Record<string, string> =
    selection === undefined
      ? { ...saved, ...supplied }
      : {
          ...(saved.personality ? { personality: saved.personality } : {}),
          ...(saved.interactionMode ? { interactionMode: saved.interactionMode } : {}),
          ...selection
        }
  // A missing Fast pick has a definite baseline on hosts that offer it.
  if (
    candidate.fastMode === undefined &&
    unpickedFastModeIsOff(ctx.agent) &&
    ctx.agents.definition(ctx.agent)?.restingOptions.acceptsKey('fastMode')
  ) {
    candidate.fastMode = 'false'
  }
  const parsed = readAgentSessionExecutionOptions(candidate)
  if (!parsed) {
    return {
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        'This message has an invalid choice.'
      )
    }
  }
  const { capturedAgent: _capturedAgent, ...options } = parsed
  const refusal = structuredAgentSessionOptionOverridesRefusal(
    ctx.agents,
    ctx.agent,
    Object.fromEntries(
      Object.entries(options).filter(([key]) => !(ctx.agent === 'codex' && key === 'fastMode'))
    )
  )
  return refusal ? { refusal } : { options: { ...options, capturedAgent: ctx.agent } }
}

/** A later handoff may dispatch a waiting message on a different agent than captured its settings. */
export function submissionForActiveAgent(
  record: AgentSessionRecord | null,
  submission: AgentJournalSubmission
): AgentJournalSubmission {
  const captured = submission.options?.capturedAgent
  const stale =
    record &&
    (record.providerSwitch?.clientMessageId === submission.clientMessageId ||
      (captured
        ? captured !== record.provider
        : submission.options && record.providerHandleChain.some(({ switchedBy }) => switchedBy)))
  if (!stale && !captured) {
    return submission
  }
  const { capturedAgent: _capturedAgent, ...options } =
    (stale ? readAgentSessionExecutionOptions(record.options ?? {}) : submission.options) ?? {}
  return { ...submission, options }
}

/** The model and effort the chat was created with, which its opening message runs on as a send's
 *  carried ones do. */
export function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: AgentSessionExecutionOptions
} {
  const { model, effort, interactionMode } = options ?? {}
  const captured = readAgentSessionExecutionOptions({
    ...(model ? { model, ...(effort ? { effort } : {}) } : {}),
    ...(interactionMode ? { interactionMode } : {})
  })
  return captured && Object.keys(captured).length > 0 ? { options: captured } : {}
}
