import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { readCodexConfiguredLaunchDefaults } from './codex-configured-launch-defaults'
import { codexAcquireCatalogListing } from './codex-structured-catalog-entry'
import { CODEX_DEFAULT_SERVICE_TIER } from './codex-structured-service-tier'
import type { CodexSession } from './codex-structured-session-state'
import { applyCodexStructuredSessionOption } from './codex-structured-session-options'

/** Resolve one message's choices and baseline without changing the next pick. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  const listing = codexAcquireCatalogListing(session.catalogAccess)
  const priorModel = session.options.get('model')
  const priorEffort = session.options.get('effort')
  // An unchosen key keeps what the thread runs; another model brings its own default effort.
  const thread = session.reportedOptions
  const model =
    choices.model ?? thread.model ?? listing?.models.find((entry) => entry.isDefault)?.id
  if (!model && (choices.effort || priorModel || priorEffort)) {
    throw new AgentSessionOptionRejectedError(new Error('codex default model is unavailable'))
  }
  const listedModel = listing?.models.find((entry) => entry.id === model)
  const threadEffort = model === thread.model ? thread.effort : undefined
  const defaultEffort = threadEffort ?? listedModel?.defaultEffort
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
    // Captured intent was admitted when picked; an installation change cannot rewrite it.
    selected.options.set('model', model)
    if (!defaultEffort && choices.effort === undefined) {
      selected.options.delete('effort')
    }
    // Where the model brought an effort, it is the thread's own for the thread's model.
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
