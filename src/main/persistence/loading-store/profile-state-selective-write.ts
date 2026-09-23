import type { ProtectedSecretRetentionUpdate } from '../../protected-secret-persistence'
import type { ProfileStateAuthority } from './profile-state-authority'
import { buildProfileStateDomainReplacements } from './profile-state-authority-writes'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import type { AutomationRun } from '../../../shared/automations-types'

export type SelectiveProfileStateWriteResult = {
  handled: boolean
  aborted: boolean
  consumedAutomationRuns: boolean
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
}

export function writeSelectiveProfileState(
  authority: ProfileStateAuthority | undefined,
  serialization: StateSerializationSecretHandlingOperations,
  dirtyDomains: Set<string> | null,
  pendingAutomationRunsAfter: readonly AutomationRun[] | undefined,
  isCurrent?: () => boolean
): SelectiveProfileStateWriteResult {
  if (
    !authority ||
    dirtyDomains === null ||
    dirtyDomains.size === 0 ||
    !authority.writeSerializedDomains
  ) {
    return {
      handled: false,
      aborted: false,
      consumedAutomationRuns: false,
      protectedSecretUpdates: []
    }
  }
  const useAutomationDelta =
    pendingAutomationRunsAfter !== undefined &&
    authority.writeSerializedAutomationRuns !== undefined
  const serializableDomains = useAutomationDelta
    ? new Set([...dirtyDomains].filter((domain) => domain !== 'automationRuns'))
    : dirtyDomains
  const built = serialization.buildStateDomainsToSave(serializableDomains)
  if (built === undefined) {
    return {
      handled: false,
      aborted: false,
      consumedAutomationRuns: false,
      protectedSecretUpdates: []
    }
  }
  const { payload, protectedSecretUpdates } = built
  if (isCurrent && !isCurrent()) {
    return {
      handled: true,
      aborted: true,
      consumedAutomationRuns: false,
      protectedSecretUpdates: []
    }
  }
  if (useAutomationDelta) {
    authority.writeSerializedAutomationRuns?.(
      buildProfileStateDomainReplacements(payload, serializableDomains),
      pendingAutomationRunsAfter
    )
  } else {
    authority.writeSerializedDomains(buildProfileStateDomainReplacements(payload, dirtyDomains))
  }
  dirtyDomains.clear()
  return {
    handled: true,
    aborted: false,
    consumedAutomationRuns: pendingAutomationRunsAfter !== undefined,
    protectedSecretUpdates
  }
}
