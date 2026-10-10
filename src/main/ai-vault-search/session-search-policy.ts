import {
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  resolveAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Why a source and not a captured value: the scanner child is spawned lazily and
// respawned after a fault, so its init frame has to read consent at spawn time.
// Before a composition root installs one, every read is the safe default (off).
let readSettings: (() => AiVaultSearchSettings) | null = null

export function installSessionSearchPolicySource(
  source: (() => Pick<GlobalSettings, 'aiVaultSearch'>) | null
): void {
  readSettings = source ? () => resolveAiVaultSearchSettings(source()) : null
}

export function sessionSearchPolicy(): AiVaultSearchSettings {
  return readSettings?.() ?? DEFAULT_AI_VAULT_SEARCH_SETTINGS
}

export function resetSessionSearchPolicyForTests(): void {
  readSettings = null
}
