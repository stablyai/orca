import { getAppEnvironment } from '../../shared/app-environment'
import type { Automation } from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence/loading-store/store'
import { isManagedOrcadSshTarget } from '../ssh/connection/ssh-connection-store'
import { listOrcadMigrationCutoverChainForTarget } from '../ssh/orcad-migration-cutover-journal'

export const ORCAD_FENCED_AUTOMATION = "This automation now runs on its SSH host's Orca server."

/** While a move is in flight, or once it took this row, any desktop write would break or duplicate it. Rows Move anyway left behind stay listed, skipped by managedOrcadHostOf. */
export function isOrcadFencedAutomation(
  store: Pick<Store, 'getSshTarget'>,
  automation: Pick<Automation, 'id' | 'executionTargetType' | 'executionTargetId'>,
  userDataPath: () => string = () => getAppEnvironment().getPath('userData')
): boolean {
  if (
    automation.executionTargetType !== 'ssh' ||
    store.getSshTarget(automation.executionTargetId)?.orcadFence === undefined
  ) {
    return false
  }
  let chain
  try {
    chain = listOrcadMigrationCutoverChainForTarget(userDataPath(), automation.executionTargetId)
  } catch {
    return true // An unreadable journal can't show the row stayed behind.
  }
  return (
    chain.length === 0 ||
    chain.some(
      (cutover) =>
        cutover.phase === 'source-fenced' ||
        cutover.phase === 'destination-staged' ||
        cutover.manifest.payload.dormantState?.automations?.some(({ id }) => id === automation.id)
    )
  )
}

/** A desktop row on a host its managed Orca server now serves: it can never run here (#27499). */
export function managedOrcadHostOf(
  store: Pick<Store, 'getSshTarget' | 'automationOwnerPrecondition'>,
  automation: Pick<Automation, 'id' | 'executionTargetType' | 'executionTargetId'>
): SshTarget | null {
  // The owner selector also covers local rows pinned to an SSH workspace.
  const selector = store.automationOwnerPrecondition(automation.id)?.selector
  const targetId =
    selector?.kind === 'ssh'
      ? selector.targetId
      : automation.executionTargetType === 'ssh'
        ? automation.executionTargetId
        : null
  const target = targetId ? store.getSshTarget(targetId) : undefined
  return target && isManagedOrcadSshTarget(target) ? target : null
}
