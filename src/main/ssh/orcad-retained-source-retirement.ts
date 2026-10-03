/**
 * Retiring a converted host's retained source once source retirement is switched on: every
 * manifest in the host's chain, oldest first, and only after its newest move committed.
 */
import { isRetainedOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { listOrcadMigrationCutoverChainForTarget } from './orcad-migration-cutover-journal'
import { retireOrcadMigrationSource } from './orcad-migration-source-retirement'
import { compareRetainedOrcadSource } from './orcad-retained-source'

export async function retireRetainedOrcadSourceChain(
  userDataPath: string,
  store: Store,
  target: SshTarget,
  runTargetLifecycle: <T>(targetId: string, operation: () => Promise<T>) => Promise<T>
): Promise<'retired' | 'skipped'> {
  const chain = listOrcadMigrationCutoverChainForTarget(userDataPath, target.id)
  const head = chain.at(-1)
  // A delta in flight still needs every row it will move, so nothing retires before it commits.
  if (!head || !isRetainedOrcadMigrationSourceCutover(head)) {
    return 'skipped'
  }
  // Rows an older build changed are a new move, never something to delete.
  if (compareRetainedOrcadSource(store, target, head) !== 'unchanged') {
    return 'skipped'
  }
  const environment =
    listEnvironments(userDataPath).find((entry) => entry.id === head.destinationEnvironmentId) ??
    null
  for (const cutover of chain) {
    await runTargetLifecycle(target.id, () =>
      retireOrcadMigrationSource({ userDataPath, store, environment }, cutover.migrationId)
    )
  }
  return 'retired'
}
