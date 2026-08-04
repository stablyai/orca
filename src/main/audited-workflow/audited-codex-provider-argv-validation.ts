// Validation for the provider-related `-c` overrides of an audited Codex launch.
//
// Split from audited-codex-launch-plan.ts so that file stays within its line
// budget without a max-lines suppression. That module owns the ARGV SHAPE (which
// flags an audited launch carries); this one owns PROVIDER LEGALITY (whether the
// provider block in a given argv is one the registry sanctions).
import type { LaunchPlanReasonCode } from '../../shared/audited-plan-artifact-types'
import { AUDITED_CODEX_SETTINGS_IDS } from '../../shared/audited-codex-provider-types'
import {
  AUDITED_CODEX_ENV_KEY,
  AUDITED_CODEX_WIRE_APIS,
  isRegisteredCodexProviderId,
  resolveRegistryEntry,
  type AuditedCodexProviderDefinition
} from './audited-codex-provider-registry'

// The ONLY `-c` keys an audited launch may carry. Anything else — a stray
// override, a malformed provider definition, a future field — is refused rather
// than passed through, which is what stops config injection from reaching
// sandbox or approval settings.
export const ALLOWED_CONFIG_KEYS: readonly string[] = ['approval_policy', 'model_provider']
export const ALLOWED_PROVIDER_FIELDS: readonly string[] = ['base_url', 'wire_api', 'env_key']

/**
 * Validates every provider-related `-c` override as a group.
 *
 * The rules exist because the two identifier namespaces are easy to cross:
 * settings say `byesu`, argv must say `orcaAuditedByesu`. A `settingsId` in
 * argv, a segment that disagrees with `model_provider`, or a `base_url` that is
 * not the registry value for that id are each refused BEFORE any spawn.
 */
export function findProviderOverrideViolation(
  argv: readonly string[]
): LaunchPlanReasonCode | null {
  // requires_openai_auth is banned outright, for this or any provider: probe C
  // showed it leaves the injected variable unrequired, making the credential
  // source ambiguous. Refuse rather than launch something we cannot reason about.
  if (collectConfigKeysMatching(argv, (key) => key.endsWith('.requires_openai_auth')).length > 0) {
    return 'requires_openai_auth_forbidden'
  }

  const providerIds = collectConfigOverrides(argv, 'model_provider').map(stripConfigValue)
  const providerFieldKeys = collectConfigKeysMatching(argv, (key) =>
    key.startsWith('model_providers.')
  )

  if (providerIds.length === 0) {
    // No provider block at all is the built-in default path — valid, as long as
    // no orphan provider field was smuggled in beside it.
    return providerFieldKeys.length > 0 ? 'provider_settings_invalid' : null
  }
  if (providerIds.length > 1) {
    return 'provider_settings_invalid'
  }

  const providerId = providerIds[0] ?? ''
  // A valid settingsId such as `byesu` must NOT satisfy this — the namespaces
  // are separate, and crossing them is the defect this catches.
  if (!isRegisteredCodexProviderId(providerId)) {
    return 'provider_settings_invalid'
  }

  const registryEntry = findRegistryEntryByCodexProviderId(providerId)
  if (!registryEntry) {
    return 'provider_settings_invalid'
  }

  const seenFields = new Set<string>()
  for (const key of providerFieldKeys) {
    const rest = key.slice('model_providers.'.length)
    const separator = rest.indexOf('.')
    if (separator === -1) {
      return 'provider_settings_invalid'
    }
    const segment = rest.slice(0, separator)
    const field = rest.slice(separator + 1)
    // Every override must name the SAME resolved provider id.
    if (segment !== providerId) {
      return 'provider_settings_invalid'
    }
    if (!ALLOWED_PROVIDER_FIELDS.includes(field)) {
      return 'forbidden_flag_present'
    }
    if (seenFields.has(field)) {
      return 'provider_settings_invalid'
    }
    seenFields.add(field)
  }

  // All three fields are required together: a partial block would leave Codex
  // filling gaps from somewhere this launch does not control.
  for (const field of ALLOWED_PROVIDER_FIELDS) {
    if (!seenFields.has(field)) {
      return 'provider_settings_invalid'
    }
  }

  const baseUrl = stripConfigValue(
    collectConfigOverrides(argv, `model_providers.${providerId}.base_url`)[0] ?? ''
  )
  // THE ENDPOINT BINDING. Exact equality against the registry, so even if every
  // other layer were bypassed a foreign endpoint is refused before spawn.
  if (baseUrl !== registryEntry.baseUrl) {
    return 'provider_endpoint_not_allowed'
  }

  const wireApi = stripConfigValue(
    collectConfigOverrides(argv, `model_providers.${providerId}.wire_api`)[0] ?? ''
  )
  if (!AUDITED_CODEX_WIRE_APIS.includes(wireApi as (typeof AUDITED_CODEX_WIRE_APIS)[number])) {
    return 'provider_settings_invalid'
  }

  const envKey = stripConfigValue(
    collectConfigOverrides(argv, `model_providers.${providerId}.env_key`)[0] ?? ''
  )
  // An arbitrary name would let config choose which ambient variable Codex reads.
  if (envKey !== AUDITED_CODEX_ENV_KEY) {
    return 'env_key_mismatch'
  }

  return null
}

function findRegistryEntryByCodexProviderId(
  codexProviderId: string
): AuditedCodexProviderDefinition | null {
  for (const settingsId of AUDITED_CODEX_SETTINGS_IDS) {
    const entry = resolveRegistryEntry(settingsId)
    if (entry && entry.codexProviderId === codexProviderId) {
      return entry
    }
  }
  return null
}

/** Every `-c` KEY (not value) matching a predicate, in argv order. */
export function collectConfigKeysMatching(
  argv: readonly string[],
  predicate: (key: string) => boolean
): string[] {
  return collectAllConfigOverrides(argv)
    .map((override) => {
      const separator = override.indexOf('=')
      return (separator === -1 ? override : override.slice(0, separator)).trim()
    })
    .filter(predicate)
}

/** `key="value"` -> `value`; tolerates unquoted values. */
function stripConfigValue(override: string): string {
  const separator = override.indexOf('=')
  if (separator === -1) {
    return ''
  }
  const raw = override.slice(separator + 1).trim()
  return raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw
}

/**
 * Returns every `-c`/`--config` override whose key matches `key`, in argv order.
 * Both the separated and `=`-joined forms are recognized.
 */
export function collectConfigOverrides(argv: readonly string[], key: string): string[] {
  return collectAllConfigOverrides(argv).filter((value) => matchesConfigKey(value, key))
}

/**
 * Every `-c`/`--config` override in argv order, in both the separated and
 * `=`-joined spellings. One traversal shared by every config check, so a new
 * spelling never has to be taught to several collectors independently.
 */
export function collectAllConfigOverrides(argv: readonly string[]): string[] {
  const overrides: string[] = []
  const configFlags = ['-c', '--config']
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (typeof entry !== 'string') {
      continue
    }
    const inlineFlag = configFlags.find((flag) => entry.startsWith(`${flag}=`))
    if (inlineFlag) {
      overrides.push(entry.slice(inlineFlag.length + 1))
      continue
    }
    if (configFlags.includes(entry)) {
      overrides.push(argv[index + 1] ?? '')
      index += 1
    }
  }
  return overrides
}

/**
 * Whether a `-c` value sets `key`. Matches on the key up to `=` so
 * `approval_policy_extra="x"` is not mistaken for `approval_policy`.
 */
export function matchesConfigKey(value: string, key: string): boolean {
  const separator = value.indexOf('=')
  const actualKey = (separator === -1 ? value : value.slice(0, separator)).trim()
  return actualKey === key
}
