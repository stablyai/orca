import {
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  resolveAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'

// Why: the scanner child is spawned lazily and respawned after a fault, so the
// policy must be read at spawn time, not captured once. Main registers a source
// backed by the settings store; before that every read is the safe default (off).
let readSettings: (() => AiVaultSearchSettings) | null = null

export function configureSessionSearchPolicySource(
  source: (() => { aiVaultSearch?: Partial<AiVaultSearchSettings> | null }) | null
): void {
  readSettings = source ? () => resolveAiVaultSearchSettings(source()) : null
}

export function getSessionSearchPolicy(): AiVaultSearchSettings {
  return readSettings?.() ?? DEFAULT_AI_VAULT_SEARCH_SETTINGS
}

export function resetSessionSearchPolicyForTests(): void {
  readSettings = null
}
