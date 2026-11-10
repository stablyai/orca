import type { ProtectedSecretRetentionUpdate } from '../../credentials/protected-secret-persistence'
import type {
  ProfileStateAuthority,
  ProfileStateDomainReplacement,
  ProfileStateDomainPartsUpdate,
  ProfileStatePersistenceAuthority
} from './profile-state-authority'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { PendingRemoteLayoutWorkspaces } from './remote-layout-snapshot-serialization'

export type SelectiveProfileStateWriteResult = {
  handled: boolean
  aborted: boolean
  consumedAutomationRuns: boolean
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
}

export type PreparedSelectiveProfileStateWrite = {
  replacements: ProfileStateDomainReplacement[]
  automationRuns: readonly AutomationRun[] | undefined
  consumedAutomationRuns: boolean
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
  partsUpdate?: ProfileStateDomainPartsUpdate
}

export function writeSelectiveProfileState(
  authority: ProfileStateAuthority | undefined,
  serialization: StateSerializationSecretHandlingOperations,
  dirtyDomains: Set<string> | null,
  pendingAutomationRunsAfter: readonly AutomationRun[] | undefined,
  isCurrent?: () => boolean
): SelectiveProfileStateWriteResult {
  const prepared = prepareSelectiveProfileStateWrite(
    authority,
    serialization,
    dirtyDomains,
    pendingAutomationRunsAfter
  )
  if (!prepared) {
    return {
      handled: false,
      aborted: false,
      consumedAutomationRuns: false,
      protectedSecretUpdates: []
    }
  }
  if (isCurrent && !isCurrent()) {
    return {
      handled: true,
      aborted: true,
      consumedAutomationRuns: false,
      protectedSecretUpdates: []
    }
  }
  if (prepared.automationRuns !== undefined) {
    authority?.writeSerializedAutomationRuns?.(prepared.replacements, prepared.automationRuns)
  } else {
    authority?.writeSerializedDomains?.(prepared.replacements)
  }
  dirtyDomains?.clear()
  return {
    handled: true,
    aborted: false,
    consumedAutomationRuns: prepared.consumedAutomationRuns,
    protectedSecretUpdates: prepared.protectedSecretUpdates
  }
}

export function prepareSelectiveProfileStateWrite(
  authority: ProfileStatePersistenceAuthority | undefined,
  serialization: StateSerializationSecretHandlingOperations,
  dirtyDomains: ReadonlySet<string> | null,
  pendingAutomationRunsAfter: readonly AutomationRun[] | undefined,
  pendingRemoteLayoutWorkspaces?: PendingRemoteLayoutWorkspaces
): PreparedSelectiveProfileStateWrite | undefined {
  if (
    !authority ||
    dirtyDomains === null ||
    dirtyDomains.size === 0 ||
    !authority.writeSerializedDomains
  ) {
    return undefined
  }
  const useAutomationDelta =
    pendingAutomationRunsAfter !== undefined &&
    authority.writeSerializedAutomationRuns !== undefined
  const partsUpdate =
    dirtyDomains.has('remoteLayoutSnapshots') &&
    authority.writeSerializedDomainParts &&
    pendingRemoteLayoutWorkspaces
      ? serialization.buildRemoteLayoutSnapshotParts(pendingRemoteLayoutWorkspaces)
      : undefined
  const serializableDomains = new Set(
    [...dirtyDomains].filter(
      (domain) =>
        !(useAutomationDelta && domain === 'automationRuns') &&
        !(partsUpdate && domain === 'remoteLayoutSnapshots')
    )
  )
  const built = serialization.buildStateDomainsToSave(serializableDomains)
  if (built === undefined) {
    return undefined
  }
  const { replacements, protectedSecretUpdates } = built
  return {
    replacements,
    automationRuns: useAutomationDelta ? pendingAutomationRunsAfter : undefined,
    consumedAutomationRuns: pendingAutomationRunsAfter !== undefined,
    partsUpdate,
    protectedSecretUpdates
  }
}
