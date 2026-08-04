// TWO IDENTIFIER NAMESPACES, and the endpoint binding that rests on them.
//
// Settings say `byesu` (namespace 1); argv says `orcaAuditedByesu`
// (namespace 2). Conflating them is a real bug in both directions: a validator
// that accepts a settingsId in argv is too lax, and one that rejects the
// production argv is too strict. The POSITIVE case therefore comes first.
import { describe, expect, it } from 'vitest'
import {
  buildCodexPlanAuditPlan,
  findLaunchPlanViolation,
  DEFAULT_PLAN_AUDIT_MODEL
} from './audited-codex-launch-plan'
import {
  AUDITED_CODEX_ENV_KEY,
  AUDITED_CODEX_PROVIDERS,
  getSoleAuditedCodexProvider,
  isRegisteredCodexProviderId,
  resolveRegistryEntry
} from './audited-codex-provider-registry'

const BYESU = AUDITED_CODEX_PROVIDERS.byesu
const BASE = {
  model: BYESU.defaultModel,
  worktreePath: '/tmp/audited/wt',
  lastMessagePath: '/tmp/userData/audited-workflow/reviews/rev_1/last-message.txt'
}

function buildProviderArgv(): string[] {
  const plan = buildCodexPlanAuditPlan({ ...BASE, provider: BYESU })
  if (!plan.ok) {
    throw new Error(`expected a valid provider plan, got ${plan.reasonCode}`)
  }
  return plan.argv
}

describe('the Byesu production argv (POSITIVE case)', () => {
  it('builds and passes validation unchanged', () => {
    // The case an over-strict "model_provider ∈ registry ids" rule would have
    // wrongly rejected, because settings and argv speak different namespaces.
    expect(findLaunchPlanViolation(buildProviderArgv())).toBeNull()
  })

  it('carries the registry values under the codexProviderId segment', () => {
    const argv = buildProviderArgv()
    const id = BYESU.codexProviderId
    expect(argv).toContain(`model_provider="${id}"`)
    expect(argv).toContain(`model_providers.${id}.base_url="${BYESU.baseUrl}"`)
    expect(argv).toContain(`model_providers.${id}.wire_api="responses"`)
    expect(argv).toContain(`model_providers.${id}.env_key="${AUDITED_CODEX_ENV_KEY}"`)
  })

  it('still carries every mandatory read-only flag', () => {
    const argv = buildProviderArgv()
    expect(argv[0]).toBe('exec')
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(argv).toContain('approval_policy="never"')
    expect(argv).toContain('--ephemeral')
    expect(argv).toContain('--ignore-user-config')
    expect(argv).not.toContain('--skip-git-repo-check')
    expect(argv.at(-1)).toBe('-')
  })

  it('NEVER sets requires_openai_auth', () => {
    // Probe C: with it set and no env_key, Codex does not require the injected
    // variable, so the credential source becomes ambiguous.
    expect(buildProviderArgv().join(' ')).not.toContain('requires_openai_auth')
  })

  it('omits every provider override when no provider is given', () => {
    const plan = buildCodexPlanAuditPlan({ ...BASE, model: DEFAULT_PLAN_AUDIT_MODEL })
    expect(plan.ok).toBe(true)
    if (!plan.ok) {
      return
    }
    expect(plan.argv.join(' ')).not.toContain('model_provider')
    expect(findLaunchPlanViolation(plan.argv)).toBeNull()
  })
})

describe('registry mapping is one-way', () => {
  it('resolves a settingsId to its entry', () => {
    expect(resolveRegistryEntry('byesu')?.codexProviderId).toBe('orcaAuditedByesu')
  })

  it('does NOT resolve a codexProviderId as a settingsId', () => {
    expect(resolveRegistryEntry('orcaAuditedByesu')).toBeNull()
  })

  it('recognises only namespace-2 ids as Codex provider ids', () => {
    expect(isRegisteredCodexProviderId('orcaAuditedByesu')).toBe(true)
    expect(isRegisteredCodexProviderId('byesu')).toBe(false)
  })

  it('keeps the two namespaces disjoint across the whole registry', () => {
    const settingsIds = Object.values(AUDITED_CODEX_PROVIDERS).map((p) => p.settingsId)
    const codexIds = Object.values(AUDITED_CODEX_PROVIDERS).map((p) => p.codexProviderId)
    for (const codexId of codexIds) {
      expect(settingsIds).not.toContain(codexId)
    }
  })

  it('exposes exactly one fixed provider in this tranche', () => {
    expect(getSoleAuditedCodexProvider()).toBe(BYESU)
  })
})

describe('namespace crossing is refused', () => {
  it('rejects a settingsId used as model_provider', () => {
    const argv = buildProviderArgv().map((entry) =>
      entry === `model_provider="${BYESU.codexProviderId}"` ? 'model_provider="byesu"' : entry
    )
    expect(findLaunchPlanViolation(argv)).toBe('provider_settings_invalid')
  })

  it('rejects a settingsId used as the override segment', () => {
    const argv = buildProviderArgv().map((entry) =>
      entry.startsWith(`model_providers.${BYESU.codexProviderId}.base_url`)
        ? `model_providers.byesu.base_url="${BYESU.baseUrl}"`
        : entry
    )
    expect(findLaunchPlanViolation(argv)).toBe('provider_settings_invalid')
  })

  it('rejects mixed segments', () => {
    const argv = buildProviderArgv().map((entry) =>
      entry.startsWith(`model_providers.${BYESU.codexProviderId}.wire_api`)
        ? 'model_providers.orcaAuditedOther.wire_api="responses"'
        : entry
    )
    expect(findLaunchPlanViolation(argv)).toBe('provider_settings_invalid')
  })

  it('rejects an unregistered model_provider', () => {
    const argv = buildProviderArgv().map((entry) =>
      entry === `model_provider="${BYESU.codexProviderId}"`
        ? 'model_provider="orcaAuditedEvil"'
        : entry
    )
    expect(findLaunchPlanViolation(argv)).toBe('provider_settings_invalid')
  })

  it('rejects a duplicate model_provider declaration', () => {
    const argv = buildProviderArgv()
    argv.splice(-1, 0, '-c', `model_provider="${BYESU.codexProviderId}"`)
    expect(findLaunchPlanViolation(argv)).toBe('provider_settings_invalid')
  })

  it('rejects a repeated provider field', () => {
    const argv = buildProviderArgv()
    argv.splice(-1, 0, '-c', `model_providers.${BYESU.codexProviderId}.wire_api="responses"`)
    expect(findLaunchPlanViolation(argv)).toBe('provider_settings_invalid')
  })

  it('rejects an orphan provider field with no model_provider', () => {
    const plan = buildCodexPlanAuditPlan({ ...BASE, model: DEFAULT_PLAN_AUDIT_MODEL })
    if (!plan.ok) {
      throw new Error('expected a default plan')
    }
    const argv = [...plan.argv]
    argv.splice(-1, 0, '-c', `model_providers.${BYESU.codexProviderId}.base_url="x"`)
    expect(findLaunchPlanViolation(argv)).toBe('provider_settings_invalid')
  })

  it('rejects a partial provider block', () => {
    // A missing field would let Codex fill the gap from somewhere this launch
    // does not control.
    const argv = buildProviderArgv().filter(
      (entry) => !entry.startsWith(`model_providers.${BYESU.codexProviderId}.env_key`)
    )
    expect(findLaunchPlanViolation(argv)).not.toBeNull()
  })
})

describe('endpoint binding', () => {
  it('rejects a base_url that is not the registry value', () => {
    const argv = buildProviderArgv().map((entry) =>
      entry.startsWith(`model_providers.${BYESU.codexProviderId}.base_url`)
        ? `model_providers.${BYESU.codexProviderId}.base_url="https://attacker.example/v1"`
        : entry
    )
    // Exact equality against the registry — not "is it https", which proves
    // transport and not trust.
    expect(findLaunchPlanViolation(argv)).toBe('provider_endpoint_not_allowed')
  })

  it('rejects an https attacker endpoint just the same', () => {
    const argv = buildProviderArgv().map((entry) =>
      entry.startsWith(`model_providers.${BYESU.codexProviderId}.base_url`)
        ? `model_providers.${BYESU.codexProviderId}.base_url="https://byesu.com.evil.test/v1"`
        : entry
    )
    expect(findLaunchPlanViolation(argv)).toBe('provider_endpoint_not_allowed')
  })

  it('refuses to BUILD a plan whose provider entry has a foreign base URL', () => {
    const tampered = { ...BYESU, baseUrl: 'https://attacker.example/v1' }
    expect(buildCodexPlanAuditPlan({ ...BASE, provider: tampered })).toEqual({
      ok: false,
      reasonCode: 'provider_endpoint_not_allowed'
    })
  })
})

describe('env_key and requires_openai_auth', () => {
  it('rejects an env_key other than the code constant', () => {
    const argv = buildProviderArgv().map((entry) =>
      entry.startsWith(`model_providers.${BYESU.codexProviderId}.env_key`)
        ? `model_providers.${BYESU.codexProviderId}.env_key="SOME_OTHER_VAR"`
        : entry
    )
    expect(findLaunchPlanViolation(argv)).toBe('env_key_mismatch')
  })

  it('rejects requires_openai_auth for the audited provider', () => {
    const argv = buildProviderArgv()
    argv.splice(-1, 0, '-c', `model_providers.${BYESU.codexProviderId}.requires_openai_auth=true`)
    expect(findLaunchPlanViolation(argv)).toBe('requires_openai_auth_forbidden')
  })

  it('rejects requires_openai_auth for ANY provider', () => {
    const argv = buildProviderArgv()
    argv.splice(-1, 0, '-c', 'model_providers.somethingElse.requires_openai_auth=true')
    expect(findLaunchPlanViolation(argv)).toBe('requires_openai_auth_forbidden')
  })

  it('rejects an unknown -c key beside a valid provider block', () => {
    const argv = buildProviderArgv()
    argv.splice(-1, 0, '-c', 'telemetry_endpoint="https://attacker.example"')
    expect(findLaunchPlanViolation(argv)).toBe('forbidden_flag_present')
  })

  it('rejects an unknown provider FIELD', () => {
    const argv = buildProviderArgv()
    argv.splice(-1, 0, '-c', `model_providers.${BYESU.codexProviderId}.api_key="leak"`)
    expect(findLaunchPlanViolation(argv)).toBe('forbidden_flag_present')
  })
})
