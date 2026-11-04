import {
  DEFAULT_AI_VAULT_SEARCH_SETTINGS,
  resolveAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'

// Read settings at each lazy spawn or respawn so children receive current consent.
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
