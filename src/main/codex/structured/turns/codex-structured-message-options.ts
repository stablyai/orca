import { pickedSkillsInText } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat/native-chat-types'
import type { CodexTurnHost } from './codex-structured-turn-start'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { StructuredAgentSessionInputNotAdmitted } from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import { codexSessionCapabilities } from '../catalog/codex-structured-catalog-entry'
import { codexServiceTierOfFastMode } from '../catalog/codex-structured-session-options'
import {
  codexEffectiveModel,
  codexTurnRequestOptions
} from '../catalog/codex-structured-service-tier'

export function resolvedCodexGoalSettings(
  _session: CodexSession,
  choices: AgentSessionExecutionOptions = {}
) {
  return {
    ...(choices.model !== undefined ? { model: choices.model } : {}),
    ...(choices.effort !== undefined ? { effort: choices.effort } : {})
  }
}

/** Captured fields are overrides; omitted fields inherit the native thread's state. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  return compileCodexMessageOptions(session, choices)
}

export function compileCodexMessageOptions(
  session: Pick<CodexSession, 'options' | 'catalogAccess'> &
    Partial<Pick<CodexSession, 'reportedOptions' | 'appliedTurnOptions'>>,
  choices: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  const compiled: Record<string, string> = {}
  for (const key of ['model', 'effort', 'personality', 'serviceTier', 'interactionMode'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      compiled[key] = value
    }
  }
  if (choices.serviceTier === undefined && choices.fastMode !== undefined) {
    const model = codexSessionCapabilities(session).models.find(
      (row) => row.id === codexEffectiveModel(session, compiled)
    )
    compiled.serviceTier = codexServiceTierOfFastMode(choices.fastMode, model)
  }
  return codexTurnRequestOptions(session, compiled)
}

/** Compare retained input choices, without reinterpreting them through a later catalog. */
export function codexMessageInputOptions(
  choices: Readonly<Record<string, string | undefined>>,
  inherited: Readonly<Record<string, string>> = {},
  applied: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> {
  const next = { ...inherited }
  for (const key of ['model', 'effort', 'personality', 'serviceTier', 'interactionMode'] as const) {
    if (choices[key] !== undefined) {
      next[key] = choices[key]
    }
  }
  if (choices.serviceTier === undefined && choices.fastMode !== undefined) {
    const legacy = codexServiceTierOfFastMode(choices.fastMode, undefined)
    const inheritedTier = inherited.serviceTier
    const tier =
      inheritedTier === 'priority' || inheritedTier === 'fast' ? inheritedTier : applied.serviceTier
    next.serviceTier = legacy === 'fast' && (tier === 'priority' || tier === 'fast') ? tier : legacy
  }
  return next
}

/** Intent belongs to this exact acquisition; catalog/readback differences are not send barriers. */
export function readCodexAppliedInputOptions(
  session: CodexSession | undefined,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>> {
  if (
    !session ||
    session.ended ||
    session.connection.closed ||
    session.fence !== input.fence ||
    session.acquisitionGeneration !== input.acquisitionGeneration ||
    !session.appliedTurnInputOptions
  ) {
    return null
  }
  const active = session.appliedTurnInputOptions
  const requested = input.next ?? Object.fromEntries(session.options)
  return { active, next: codexMessageInputOptions(requested, active, session.appliedTurnOptions) }
}

/** Check the live binding after options settle and again whenever the provider is about to write. */
export async function prepareCodexMessageDispatch(
  session: CodexSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  registered: () => boolean
) {
  const checkAbort = () => {
    if (input.signal?.aborted) {
      throw new StructuredAgentSessionInputNotAdmitted({
        state: 'rejected',
        ...codexDispatchRejection(
          agentSessionFailureFact(session.ended ? 'providerExited' : 'cancelled')
        )
      })
    }
  }
  await input.beforeDispatch?.()
  checkAbort()
  input.onInputPreparation?.()
  const turnOptions = await waitForPromiseWithSignal(
    resolvedCodexMessageOptions(session, input.executionOptions),
    input.signal
  ).catch((error: unknown) => {
    checkAbort()
    throw error
  })
  checkAbort()
  return {
    ...input,
    turnOptions,
    isCurrent: () =>
      registered() &&
      !session.ended &&
      session.fence === input.fence &&
      input.isCurrent?.() !== false
  }
}

export function turnInputFor(
  host: CodexTurnHost,
  body: AgentJournalMessageItem
): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  let text = ''
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      input.push({ type: 'text', text: block.text })
      text += `${block.text}\n`
    } else if (block.type === 'image-ref' && block.path) {
      input.push({ type: 'localImage', path: block.path })
    } else if (block.type === 'image-ref' && block.url) {
      input.push({ type: 'image', url: block.url })
    }
  }
  // Unknown skill paths suppress plain $name resolution, so send only loaded files when known.
  for (const skill of pickedSkillsInText(text, body.skills ?? [])) {
    if (host.skillReport?.hasSkillPath(skill.path) !== false) {
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }
  }
  return input
}
