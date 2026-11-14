import type { AgentSessionAccountKind } from '../../../shared/agent-session/agent-session-availability'
import type { AgentModelCatalogSuccess } from '../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import {
  isCompleteClaudeModelListing,
  listedModels,
  record
} from '../structured/launch/claude-structured-model-catalog'
import { claudeCatalogSignedOut } from './claude-model-catalog-signed-out'
import {
  claudeFastModeSupport,
  wireClaudeModels
} from '../structured/launch/claude-structured-catalog-listing'
import { readClaudeSettingsApplied } from '../structured/launch/claude-structured-session-options'

export function readClaudeCatalogObservation(
  replies: ReadonlyMap<string, unknown>,
  env: Readonly<Record<string, string>>,
  account: AgentSessionAccountKind
): AgentModelCatalogSuccess {
  const listing = replies.get('orca-model-discovery')
  const models = listedModels(listing)
  const settings = replies.get('orca-model-settings')
  const applied = record(record(settings)?.applied)
  const configured =
    applied &&
    ['model', 'effort'].every((key) => applied[key] == null || typeof applied[key] === 'string')
      ? (readClaudeSettingsApplied(settings) ?? undefined)
      : undefined
  if (models.length === 0) {
    throw new Error('claude listed no models')
  }
  const fastModeSupport = claudeFastModeSupport(models)
  return {
    models: wireClaudeModels(models),
    origin: 'probe',
    complete: isCompleteClaudeModelListing(listing) && configured !== undefined,
    ...(fastModeSupport ? { fastModeSupport } : {}),
    ...(configured ? { configured } : {}),
    ...(claudeCatalogSignedOut(replies.get('orca-signin-discovery'), settings, env)
      ? { unavailable: { reason: 'notSignedIn', account } }
      : {})
  }
}
