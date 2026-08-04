// The code-owned audited Codex provider registry. MAIN PROCESS ONLY.
//
// Endpoints live here and nowhere else — not in settings, not in any IPC
// payload, not on disk. Adding an entry is a reviewed code change, and that is
// the whole security property: a renderer-editable base URL combined with a
// main-injected credential would be an exfiltration primitive, and HTTPS
// validation would not help (it proves transport, not trust).
//
// This module must never be imported from src/shared, src/preload, or the
// renderer. audited-codex-provider-boundary.test.ts enforces that.
import type { AuditedCodexSettingsId } from '../../shared/audited-codex-provider-types'

// The env var Codex is told to read, via the provider's `env_key`. A CODE
// CONSTANT — never in settings, never renderer-supplied. A configurable name
// would let a preference select which ambient variable Codex reads, turning a
// setting into a credential-selection primitive.
//
// DECLARATION ORDER IS LOAD-BEARING: this must precede the provider-definition
// type and the registry below, because both reference it. Declaring it after
// them is a temporal-dead-zone ReferenceError at module evaluation, and
// TypeScript rejects it as used-before-declaration.
export const AUDITED_CODEX_ENV_KEY = 'ORCA_AUDITED_CODEX_API_KEY'

// Only the value verified against codex-cli 0.145.0. Deliberately a ONE-MEMBER
// union: widening needs probe evidence against a pinned CLI plus a
// compatibility test, and a union makes adding one a reviewable act rather than
// a string edit.
export const AUDITED_CODEX_WIRE_APIS = ['responses'] as const
export type AuditedCodexWireApi = (typeof AUDITED_CODEX_WIRE_APIS)[number]

/**
 * TWO DISTINCT IDENTIFIER NAMESPACES, separately named and separately validated.
 *
 * Conflating them is a real bug: settings say `byesu` while argv says
 * `orcaAuditedByesu`, so a single `id` field plus a "model_provider must be a
 * registry id" rule would reject the correct production argv.
 */
export type AuditedCodexProviderDefinition = {
  /** Namespace 1 — the renderer/settings selection. */
  settingsId: AuditedCodexSettingsId
  /**
   * Namespace 2 — the EXACT string passed to Codex as `model_provider`, and the
   * segment in every `model_providers.<codexProviderId>.<field>` override.
   * Prefixed so an Orca-built block is never confused with a user's own.
   */
  codexProviderId: string
  /** Display only. */
  label: string
  /** Immutable constant. Never renderer-writable, never derived from settings. */
  baseUrl: string
  wireApi: AuditedCodexWireApi
  /** Fixed constant; carried per entry so argv construction reads one object. */
  envKey: typeof AUDITED_CODEX_ENV_KEY
  defaultModel: string
}

export const AUDITED_CODEX_PROVIDERS = {
  byesu: {
    settingsId: 'byesu',
    codexProviderId: 'orcaAuditedByesu',
    label: 'Byesu',
    baseUrl: 'https://byesu.com/v1',
    wireApi: 'responses',
    envKey: AUDITED_CODEX_ENV_KEY,
    defaultModel: 'gpt-5.6-sol'
  }
} as const satisfies Record<AuditedCodexSettingsId, AuditedCodexProviderDefinition>

/** Namespace 2: what argv may contain. */
export type AuditedCodexProviderId =
  (typeof AUDITED_CODEX_PROVIDERS)[AuditedCodexSettingsId]['codexProviderId']

/**
 * A CODE-OWNED DISABLED CAPABILITY — not a build-time security boundary and not
 * a feature flag. It is an ordinary source constant: it does not harden the
 * binary, and anyone who can ship modified source can change it. Its value is
 * procedural — the value cannot change at runtime (no IPC, no settings, no env
 * var reads it), so enabling delivery is necessarily a reviewed code change
 * carrying the Windows/macOS/Linux credential-propagation evidence.
 *
 * While this is false, NO code path reads the provider key for a launch and no
 * child process ever receives it.
 */
export const AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED = false

/**
 * The ONE mapping direction: settingsId -> registry entry. There is deliberately
 * no reverse lookup, so a Codex-side id can never re-enter the settings
 * namespace.
 */
export function resolveRegistryEntry(settingsId: string): AuditedCodexProviderDefinition | null {
  return (
    (AUDITED_CODEX_PROVIDERS as Record<string, AuditedCodexProviderDefinition>)[settingsId] ?? null
  )
}

/**
 * Whether a value is a registered Codex-side provider id. Used by argv
 * validation — a valid `settingsId` such as `byesu` must NOT satisfy this.
 */
export function isRegisteredCodexProviderId(value: string): value is AuditedCodexProviderId {
  return Object.values(AUDITED_CODEX_PROVIDERS).some(
    (provider) => provider.codexProviderId === value
  )
}

/** The single fixed provider. Tranche 1 derives selection rather than storing it. */
export function getSoleAuditedCodexProvider(): AuditedCodexProviderDefinition {
  return AUDITED_CODEX_PROVIDERS.byesu
}
