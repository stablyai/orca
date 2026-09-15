import type { GlobalSettings } from '../../shared/global-settings-types'

export type ManagedHookInstallCohort = 'pre-change' | 'post-change'
export type ManagedHookOnboardingDecision = 'pending' | 'passed'

/**
 * The installation-scoped record the policy reads. Declared here, next to its only consumer, so
 * the `orca` CLI can compile the policy without the persistence module that writes it.
 */
export type ManagedHookInstallationMarker = {
  installCohort: ManagedHookInstallCohort
  onboardingDecision: ManagedHookOnboardingDecision
}

/**
 * The single authorization answer every writer of user-global agent config must obtain.
 *
 * A tri-state, not a boolean: `false` at the writer boundary means "remove", so "not asked yet" was
 * previously unrepresentable and any caller that synthesized one swept files a different Orca
 * profile owns (STA-5679). `defer` writes nothing and removes nothing.
 */
export type ManagedHookInstallDecision =
  | { kind: 'allow'; reason: 'pre-change' | 'onboarding-passed' | 'headless' }
  | { kind: 'defer'; reason: 'onboarding-pending' }
  | { kind: 'deny'; reason: 'hooks-disabled' }

/** Only `desktop` paints the onboarding question; every other host installs as it always has. */
export type ManagedHookInstallHostMode = 'desktop' | 'serve' | 'orcad' | 'cli'

export type ManagedHookInstallPolicySettings =
  | Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled'>>
  | null
  | undefined

const ALLOW_PRE_CHANGE: ManagedHookInstallDecision = { kind: 'allow', reason: 'pre-change' }
const ALLOW_HEADLESS: ManagedHookInstallDecision = { kind: 'allow', reason: 'headless' }
const ALLOW_PASSED: ManagedHookInstallDecision = { kind: 'allow', reason: 'onboarding-passed' }
const DEFER_PENDING: ManagedHookInstallDecision = { kind: 'defer', reason: 'onboarding-pending' }
const DENY_DISABLED: ManagedHookInstallDecision = { kind: 'deny', reason: 'hooks-disabled' }

function isExplicitlyDisabled(settings: ManagedHookInstallPolicySettings): boolean {
  return settings?.agentStatusHooksEnabled === false
}

export function getManagedHookInstallDecision(input: {
  settings: ManagedHookInstallPolicySettings
  /** Omitted by hosts that establish no marker; an unrecorded installation is a pre-change one. */
  installation?: ManagedHookInstallationMarker
  mode: ManagedHookInstallHostMode
}): ManagedHookInstallDecision {
  // Order is load-bearing. The off switch wins over everything, including the pre-change cohort.
  if (isExplicitlyDisabled(input.settings)) {
    return DENY_DISABLED
  }
  if (input.installation?.installCohort !== 'post-change') {
    return ALLOW_PRE_CHANGE
  }
  if (input.mode !== 'desktop') {
    return ALLOW_HEADLESS
  }
  return input.installation.onboardingDecision === 'pending' ? DEFER_PENDING : ALLOW_PASSED
}

/**
 * The verdict the install chokepoint acts on.
 *
 * A caller may supply its own decision — the startup pass and the CLI both do, so their plan and
 * their write cannot disagree — but the off switch is never overridable that way. "Unchecked never
 * installs, from any caller" has to hold even for a caller whose decision was computed from a
 * settings snapshot that has since gone stale.
 */
export function authorizeManagedHookInstall(
  settings: ManagedHookInstallPolicySettings,
  supplied?: ManagedHookInstallDecision
): ManagedHookInstallDecision {
  if (isExplicitlyDisabled(settings)) {
    return DENY_DISABLED
  }
  return supplied ?? resolveManagedHookInstallDecision(settings)
}

type ManagedHookInstallDecisionResolver = (
  settings: ManagedHookInstallPolicySettings
) => ManagedHookInstallDecision

let resolver: ManagedHookInstallDecisionResolver | null = null

/** Installed by the desktop bootstrap once the installation marker and host mode are known. */
export function setManagedHookInstallDecisionResolver(
  next: ManagedHookInstallDecisionResolver | null
): void {
  resolver = next
}

/**
 * The ambient decision for hosts that do not pass one explicitly.
 *
 * With no resolver — the `orca` CLI's own process, `orcad`, a unit test, a boot step that runs
 * before the marker exists — this answers `allow`, because an unestablished installation is an
 * ambiguous one and ambiguity installs. The off switch is still honoured here so "unchecked never
 * installs, from any caller" does not depend on the resolver being wired.
 */
export function resolveManagedHookInstallDecision(
  settings: ManagedHookInstallPolicySettings
): ManagedHookInstallDecision {
  if (resolver) {
    return resolver(settings)
  }
  return isExplicitlyDisabled(settings) ? DENY_DISABLED : ALLOW_PRE_CHANGE
}
