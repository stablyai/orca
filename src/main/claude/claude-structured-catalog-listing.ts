// What a Claude child's listing says about its account, apart from this session's own state.

import type {
  AgentSessionFastModeSupport,
  AgentSessionOptionsResult
} from '../../shared/agent-session-wire'
import type {
  AgentModelCatalogConfiguredChoice,
  AgentModelCatalogLiveListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import type { ListedModel } from './claude-structured-model-catalog'
import type { ClaudeSession } from './claude-structured-session-state'

const TRANSIENT_FAST_MODE_REASONS = new Set(['network_error', 'unknown', 'pending'])
const NON_BLOCKING_FAST_MODE_REASONS = new Set(['preference', 'sdk_opt_in_required'])

export function claudeFastModeSupport(
  models: readonly ListedModel[],
  disabledReason: string | undefined
): AgentSessionFastModeSupport | undefined {
  if (disabledReason && TRANSIENT_FAST_MODE_REASONS.has(disabledReason)) {
    return undefined
  }
  if (disabledReason && !NON_BLOCKING_FAST_MODE_REASONS.has(disabledReason)) {
    return { supported: false, reason: disabledReason }
  }
  if (!models.some((model) => model.supportsFastMode === true)) {
    return models.length > 0 && models.every((model) => model.supportsFastMode === false)
      ? { supported: false, reason: 'model-not-supported' }
      : undefined
  }
  return { supported: true }
}

export type WireClaudeModel = AgentSessionOptionsResult['models'][number]

function wireClaudeModel(entry: ListedModel): WireClaudeModel {
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    isDefault: entry.isDefault,
    efforts: entry.efforts,
    ...(entry.supportsFastMode !== undefined ? { supportsFastMode: entry.supportsFastMode } : {})
  }
}

export function wireClaudeModels(models: readonly ListedModel[]): WireClaudeModel[] {
  return models.map(wireClaudeModel)
}

/** The account-level facts of a provider listing, for the host to save: this session's disabled
 *  reason and its unlisted current model stay out, so another surface never inherits session state
 *  as a catalog. A child launched with `--model X` lists X itself (Claude Code 2.1.280 adds a row
 *  named by the raw id, "Custom model"), whether or not X exists; native rows carry a display name
 *  of their own, so a row named by its id is the launch talking, not the account. */
export function claudeCatalogListing(
  session: ClaudeSession,
  discovered: ListedModel[],
  /** `withConfiguredDefault`: only the start's settings readback says what the config resolved;
   *  every later read omits it. */
  options: { withConfiguredDefault?: boolean } = {}
): AgentModelCatalogLiveListing | undefined {
  if (discovered.length === 0) {
    return undefined
  }
  const launched = session.launchedModel
  const launchOnly =
    launched !== null && discovered.some((row) => row.id === launched && row.label === row.id)
  const support = claudeFastModeSupport(discovered, undefined)
  const configured = options.withConfiguredDefault
    ? configuredClaudeDefault(session, discovered)
    : undefined
  return {
    // No default effort here: the CLI's effort is a config fact, saved with the configured model.
    models: wireClaudeModels(discovered),
    ...(support ? { fastModeSupport: support } : {}),
    ...(launchOnly ? { launchOnlyModelId: launched } : {}),
    ...(configured !== undefined ? { configuredDefault: configured } : {})
  }
}

/** With no model sent at launch or since, the model and effort the CLI says it applies are its own
 *  resolution of env over settings over its default: the configured default for this session's
 *  config scope. Null when that resolution names no listed model; undefined when the session
 *  picked its own model or never read its settings back. */
function configuredClaudeDefault(
  session: ClaudeSession,
  discovered: ListedModel[]
): AgentModelCatalogConfiguredChoice | null | undefined {
  const applied = session.appliedOptions
  if (session.launchedModel !== null || session.options.has('model') || !applied) {
    return undefined
  }
  const row = applied.model
    ? discovered.find(
        (entry) => entry.id === applied.model || entry.resolvedModel === applied.model
      )
    : undefined
  if (!row) {
    return null
  }
  const runs = row.resolvedModel ?? row.id
  const sameModelIds = discovered
    .filter((entry) => entry !== row && (entry.resolvedModel ?? entry.id) === runs)
    .map((entry) => entry.id)
  return {
    modelId: row.id,
    ...(sameModelIds.length > 0 ? { sameModelIds } : {}),
    // An effort this session picked is its own and says nothing of the config's.
    ...(session.options.has('effort') ? {} : { effort: applied.effort ?? null })
  }
}
