// Validate scope synchronously before probing a provider or contacting another host.

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
import {
  isManagedOrcadSshTarget,
  isRuntimeOwnedSshTarget
} from '../ssh/connection/ssh-connection-store'

/** Include hidden registrations so the guard can reject them before comparing generations. */
export type DesktopSshTargetRegistry = {
  getSshTargets: () => SshTarget[]
}

export type ResolvedExternalAutomationScope = {
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  sshTarget: SshTarget | null
  managerId: string
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
  // Hide registration details before reporting generation mismatches.
  if (isRuntimeOwnedSshTarget(target) || isManagedOrcadSshTarget(target)) {
    throw new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden)
  }
  const current = sanitizeSshTargetGeneration(target.generation)
  if (current === undefined || current !== capturedGeneration) {
    throw externalAutomationHostChangedError()
  }
  return target
}

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
