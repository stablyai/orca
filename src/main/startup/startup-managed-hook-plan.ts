import {
  resolveManagedHookInstallDecision,
  type ManagedHookInstallDecision,
  type ManagedHookInstallPolicySettings
} from '../agent-hooks/managed-hook-install-policy'

export type StartupManagedHookPlan = {
  /** Carried to the installers so the startup pass and the chokepoint cannot disagree. */
  decision: ManagedHookInstallDecision
  /** Run the startup install/refresh pass over every enabled agent. */
  shouldReconcile: boolean
}

/**
 * Thin adapter: the host mode and the installation marker were settled in preflight, so startup
 * only adds "does this build reconcile hooks at all".
 */
export function resolveStartupManagedHookPlan(input: {
  /** `shouldInstallManagedHooks(is.dev)` — whether this build reconciles hooks at all. */
  managedHooksInstallable: boolean
  settings: ManagedHookInstallPolicySettings
}): StartupManagedHookPlan {
  const decision = resolveManagedHookInstallDecision(input.settings)
  return {
    decision,
    shouldReconcile: input.managedHooksInstallable && decision.kind === 'allow'
  }
}
