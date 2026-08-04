// Resolves which Codex provider an audited plan audit should use. MAIN ONLY.
//
// ONE DURABLE STORE. The encrypted key record is the sole provider state:
// its presence derives the selection of the sole fixed provider. There is no
// GlobalSettings write, so there is no cross-store window to reconcile and no
// "atomic" claim to make about two stores that share no transaction.
//
// The `auditedCodexProvider` settings field is deliberately NOT read here. It
// exists so GlobalSettings and preload can be typed ahead of the future picker,
// and it is dropped from every renderer-originated settings update — so a
// hand-planted or stale value is inert and cannot activate anything.
import type { AuditedCodexProviderStatus } from '../../shared/audited-codex-provider-types'
import type { PlanReviewReasonCode } from '../../shared/audited-plan-artifact-types'
import {
  AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED,
  getSoleAuditedCodexProvider,
  type AuditedCodexProviderDefinition
} from './audited-codex-provider-registry'
import { hasAuditedCodexProviderKey } from './audited-codex-provider-key-store'

export type AuditedCodexProviderResolution =
  // `provider: null` is the built-in default path — unchanged Phase 5 behaviour.
  | { ok: true; provider: AuditedCodexProviderDefinition | null; model: string | null }
  | { ok: false; reasonCode: PlanReviewReasonCode }

/**
 * Resolves the provider for a launch, or refuses with a closed code.
 *
 * PRESENCE ONLY — this function NEVER reads the key value. `hasAuditedCodexProviderKey`
 * is an opaque existence check; nothing here decrypts, and nothing here can
 * observe the secret. That is the whole point: while credential delivery is
 * disabled, admission must not touch the value even to validate it.
 *
 * Two codes are consequently NOT produced here in this tranche:
 *  - `provider_not_configured` would require distinguishing a corrupt record
 *    from a good one, which means decrypting it. Reserved for the future
 *    independently-selected-provider tranche, where a selection can exist
 *    without a key and the distinction is observable without a read.
 *  - `provider_settings_invalid` would require a persisted selection to
 *    validate; there is none. Still produced by the argv layer.
 */
export function resolveAuditedCodexProvider(): AuditedCodexProviderResolution {
  // 0. The probe itself can fail — an unreadable ~/.orca, a permission error, an
  //    unresolvable home path. THIS MUST NOT THROW: an escaping exception would
  //    leave startPlanAudit rejecting, and the IPC catch-all would then report
  //    `spawn_failed` — untruthful, because nothing spawned — while logging the
  //    raw error with its filesystem path.
  //
  //    Refusing is also the only truthful option: we did not observe an absence,
  //    so "not configured" would be a guess; and we did not observe a presence,
  //    so "delivery unavailable" would be a different guess.
  const probe = probeKeyPresence()
  if (!probe.ok) {
    return { ok: false, reasonCode: 'provider_storage_unavailable' }
  }

  // 1. No record ⇒ no custom provider. Selection is derived, so "no key" and
  //    "no provider" are the same fact.
  if (!probe.present) {
    return { ok: true, provider: null, model: null }
  }

  // 2. A record exists — whatever its contents, which are never inspected.
  //    Orca is deliberately declining to deliver the secret. Not
  //    `provider_not_configured`: that would misreport the user's own state and
  //    send them to configure something they already configured.
  if (!AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED) {
    return { ok: false, reasonCode: 'credential_delivery_unavailable' }
  }

  // 3. Unreachable while the capability is disabled. Kept as the honest shape of
  //    the success case rather than a throw, so enabling delivery is a one-line
  //    capability change plus the launcher overlay, reviewed together.
  const provider = getSoleAuditedCodexProvider()
  return { ok: true, provider, model: provider.defaultModel }
}

/**
 * The two status facts, computed from the SAME single record — so they cannot
 * disagree. Never returns the key, a masked form, a path, or the endpoint.
 */
export function getAuditedCodexProviderStatus(): AuditedCodexProviderStatus {
  const configured = safeHasAuditedCodexProviderKey()
  return {
    settingsId: configured ? getSoleAuditedCodexProvider().settingsId : null,
    keyConfigured: configured
  }
}

/**
 * The ONE guarded call site for the opaque key-existence probe.
 *
 * `existsSync` today, but not contractually guaranteed never to throw (EACCES on
 * ~/.orca itself, an unresolvable home path). Both callers need the failure as a
 * value rather than an exception, and routing them through one helper means a
 * future caller cannot accidentally reintroduce the unguarded form.
 *
 * The diagnostic is a FIXED STRING: the raw error can embed the key path, and
 * console output is captured in logs and bug reports.
 */
function probeKeyPresence(): { ok: true; present: boolean } | { ok: false } {
  try {
    return { ok: true, present: hasAuditedCodexProviderKey() }
  } catch {
    console.error('[auditedWorkflow] Checking the Codex provider key status failed.')
    return { ok: false }
  }
}

/**
 * Status treats an unanswerable probe as "not configured" DELIBERATELY, and this
 * differs from the resolver on purpose. Status is a display fact with no safe
 * third state — the pane must render something — and showing "not configured"
 * invites the user to configure a key, which is harmless. Admission has a real
 * third option (refuse), and taking it is what keeps the launch path from acting
 * on a guess.
 */
function safeHasAuditedCodexProviderKey(): boolean {
  const probe = probeKeyPresence()
  return probe.ok ? probe.present : false
}
