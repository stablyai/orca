import { pickedSkillsInText } from '../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { CodexTurnHost } from './codex-structured-turn-start'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { readCodexConfiguredLaunchDefaults } from './codex-configured-launch-defaults'
import { codexAcquireCatalogListing } from './codex-structured-catalog-entry'
import { CODEX_DEFAULT_SERVICE_TIER } from './codex-structured-service-tier'
import type { CodexSession } from './codex-structured-session-state'
import { applyCodexStructuredSessionOption } from './codex-structured-session-options'

function codexModelDefaults(session: CodexSession, selected?: string) {
  const listing = codexAcquireCatalogListing(session.catalogAccess)
  const model =
    selected ??
    session.reportedOptions.model ??
    listing?.models.find((entry) => entry.isDefault)?.id
  const defaultEffort =
    (model === session.reportedOptions.model ? session.reportedOptions.effort : undefined) ??
    listing?.models.find((entry) => entry.id === model)?.defaultEffort
  return { model, defaultEffort }
}

export function resolvedCodexGoalSettings(
  session: CodexSession,
  choices: AgentSessionExecutionOptions = {}
) {
  const { model, defaultEffort } = codexModelDefaults(session, choices.model)
  const effort = choices.effort ?? defaultEffort
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** Resolve per-message overrides without replacing the session's saved picks. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  const priorModel = session.options.get('model')
  const priorEffort = session.options.get('effort')
  // Keep the thread's effort unless switching models.
  const { model, defaultEffort } = codexModelDefaults(session, choices.model)
  if (!model && (choices.effort || priorModel || priorEffort)) {
    throw new AgentSessionOptionRejectedError(new Error('codex default model is unavailable'))
  }
  if (choices.effort === undefined && priorEffort && !defaultEffort) {
    throw new AgentSessionOptionRejectedError(new Error('codex default effort is unavailable'))
  }
  // Capture configuration before our first override, never from mutable turn reports.
  if (
    (choices.personality && !session.nativeDefaults?.personality) ||
    ((choices.serviceTier || choices.fastMode) && !session.nativeDefaults?.serviceTier)
  ) {
    const configured = await readCodexConfiguredLaunchDefaults(session.connection)
    session.nativeDefaults = {
      ...session.nativeDefaults,
      ...(configured?.personality && !session.nativeDefaults?.personality
        ? { personality: configured.personality }
        : {}),
      ...(configured?.serviceTier && !session.nativeDefaults?.serviceTier
        ? { serviceTier: configured.serviceTier }
        : {})
    }
  }
  const restored: Record<string, string> = {}
  for (const key of ['personality', 'serviceTier'] as const) {
    const applied = session.appliedTurnOptions?.[key]
    if (
      choices[key] !== undefined ||
      (key === 'serviceTier' && choices.fastMode !== undefined) ||
      !applied
    ) {
      continue
    }
    const baseline = session.nativeDefaults?.[key]
    if (!baseline) {
      throw new AgentSessionOptionRejectedError(new Error(`codex default ${key} is unavailable`))
    }
    if (applied !== baseline) {
      restored[key] = baseline
    }
  }
  const selected = {
    ...session,
    options: new Map<string, string>(Object.entries(restored)),
    reportedOptions: { ...session.reportedOptions, effort: undefined }
  }
  if (
    model &&
    (choices.model ||
      priorModel ||
      priorEffort ||
      choices.effort ||
      choices.fastMode === 'true' ||
      (choices.serviceTier && choices.serviceTier !== CODEX_DEFAULT_SERVICE_TIER))
  ) {
    // Preserve previously admitted choices across installation changes.
    selected.options.set('model', model)
    if (!defaultEffort && choices.effort === undefined) {
      selected.options.delete('effort')
    }
    if (
      choices.effort === undefined &&
      defaultEffort &&
      (priorEffort || choices.model || selected.options.has('effort'))
    ) {
      selected.options.set('effort', defaultEffort)
    }
  }
  for (const key of ['effort', 'personality', 'fastMode', 'serviceTier'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      if (key === 'fastMode') {
        await applyCodexStructuredSessionOption(selected, key, value)
      } else {
        selected.options.set(key, value)
      }
    }
  }
  return Object.fromEntries(selected.options)
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
