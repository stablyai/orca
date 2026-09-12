import { stageOrcadLiveDestination } from './orcad-live-destination-staging'
import { publishOrcadLiveTerminals } from './orcad-live-terminal-publication'
import { commitOrcadLiveDestination } from './orcad-live-destination-commit'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { withOrcadLiveSourceRecovery } from './orcad-live-source-recovery'

/** Source admission and lifecycle locks remain owned by the caller throughout. */
export async function migrateOrcadLiveDestination(
  options: Parameters<typeof publishOrcadLiveTerminals>[0] & {
    remote?: NonNullable<Parameters<typeof stageOrcadLiveDestination>[0]['remote']> &
      NonNullable<Parameters<typeof commitOrcadLiveDestination>[0]['remote']>
  }
) {
  const cutover = parseOrcadMigrationSourceCutover(options.cutover)
  if (cutover.phase === 'destination-committed') {
    return commitOrcadLiveDestination({ ...options, cutover })
  }
  const staged = await stageOrcadLiveDestination(options)
  const published = await publishOrcadLiveTerminals({ ...options, cutover: staged })
  return commitOrcadLiveDestination({ ...options, cutover: published })
}

export async function resumeOrcadLiveDestination(
  options: Parameters<typeof withOrcadLiveSourceRecovery>[0] & {
    runtime: Parameters<typeof publishOrcadLiveTerminals>[0]['runtime'] &
      Parameters<typeof withOrcadLiveSourceRecovery>[0]['runtime']
    remote?: Parameters<typeof migrateOrcadLiveDestination>[0]['remote']
  }
) {
  return withOrcadLiveSourceRecovery(options, (context) =>
    migrateOrcadLiveDestination({ ...options, ...context })
  )
}
