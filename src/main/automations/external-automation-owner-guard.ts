/**
 * The fail-closed checks every scoped external-manager call re-applies *before*
 * contacting a relay or launching a provider command.
 *
 * Resolution is fully synchronous on purpose: a rejected scope has performed no
 * probe, because there is no await between the request arriving and the throw.
 */

import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError,
  externalAutomationHostChangedError,
  externalAutomationManagerId,
  externalAutomationTargetForOwner,
  externalAutomationTargetRemovedError,
  isExternalAutomationProvider,
  type ScopedExternalAutomationRequest
} from '../../shared/external-automation-scope'
import { ownerKey } from '../../shared/automation-owner-key'
import { sanitizeSshTargetGeneration } from '../../shared/ssh-target-generation'
import type {
  ExternalAutomationProvider,
  ExternalAutomationTarget
} from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import { isRuntimeOwnedSshTarget } from '../ssh/ssh-connection-store'

/** Current SSH registrations, hidden ones included so the guard can reject them itself. */
export type DesktopSshTargetRegistry = {
  getSshTargets: () => SshTarget[]
}

export type ResolvedExternalAutomationScope = {
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  /** Set only for SSH scopes, already proven desktop-visible and current. */
  sshTarget: SshTarget | null
  managerId: string
  /** Cache, coalescing, and cancellation key for this `{owner, provider}`. */
  ownerKey: string
}

function resolveSshScope(
  targetId: string,
  capturedGeneration: number,
  registry: DesktopSshTargetRegistry
): SshTarget {
  const target = registry.getSshTargets().find((entry) => entry.id === targetId)
  if (!target) {
    throw externalAutomationTargetRemovedError()
  }
  // Why: checked before the generation compare so a hidden target reveals nothing about its registration.
  if (isRuntimeOwnedSshTarget(target)) {
    throw new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden)
  }
  const current = sanitizeSshTargetGeneration(target.generation)
  if (current === undefined || current !== capturedGeneration) {
    throw externalAutomationHostChangedError()
  }
  return target
}

/**
 * Validates provider, authority, and host incarnation for one scoped request.
 * Throws `ExternalAutomationScopeError` or `AutomationOwnerConflictError`; never probes.
 */
export function resolveExternalAutomationScope(
  request: ScopedExternalAutomationRequest,
  registry: DesktopSshTargetRegistry
): ResolvedExternalAutomationScope {
  if (!isExternalAutomationProvider(request.provider)) {
    throw new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed)
  }
  const { owner } = request
  if (owner.authority.kind !== 'desktop') {
    throw new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
  }
  if (owner.selector.kind !== 'self' && owner.selector.kind !== 'ssh') {
    throw new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported)
  }
  const sshTarget =
    owner.selector.kind === 'ssh'
      ? resolveSshScope(owner.selector.targetId, owner.selector.targetGeneration, registry)
      : null
  return {
    provider: request.provider,
    target: externalAutomationTargetForOwner(owner),
    sshTarget,
    managerId: externalAutomationManagerId(owner, request.provider),
    ownerKey: ownerKey(owner)
  }
}
