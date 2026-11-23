import type { ProtectedSecretRetentionUpdate } from '../../../credentials/protected-secret-persistence'
import type {
  ProfileStateAuthority,
  ProfileStateDomainReplacement,
  ProfileStatePersistenceAuthority
} from './profile-state-authority'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { ProfileStateDomainPatch } from '../../profile-state/documents/profile-state-domain-patches'
import type { WorkspaceSessionSaveCandidate } from './workspace-session-save-baseline'

export type SelectiveProfileStateWriteResult = {
  handled: boolean
  aborted: boolean
  consumedAutomationRuns: boolean
  protectedSecretUpdates: ProtectedSecretRetentionUpdate[]
}

export type PreparedSelectiveProfileStateWrite = {
  replacements: ProfileStateDomainReplacement[]
  patches: ProfileStateDomainPatch[]
  sessionCandidates: WorkspaceSessionSaveCandidate[]
  automationRuns: readonly AutomationRun[] | undefined
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
  patchSessions = false
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
  const serializableDomains = useAutomationDelta
    ? new Set([...dirtyDomains].filter((domain) => domain !== 'automationRuns'))
    : dirtyDomains
  // Run-row deltas travel in their own command, which carries no patches.
  const built = serialization.buildStateDomainsToSave(
    serializableDomains,
    patchSessions ? (useAutomationDelta ? 'whole' : 'patch') : undefined
  )
  if (built === undefined) {
    return undefined
  }
  const { replacements, patches, sessionCandidates, protectedSecretUpdates } = built
  return {
    replacements,
    patches,
    sessionCandidates,
    automationRuns: useAutomationDelta ? pendingAutomationRunsAfter : undefined,
    consumedAutomationRuns: pendingAutomationRunsAfter !== undefined,
    protectedSecretUpdates
  }
}
