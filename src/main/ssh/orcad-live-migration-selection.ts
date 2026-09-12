import { z } from 'zod'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import type {
  OrcadLiveMigrationProgress,
  OrcadLiveMigrationResumeSelection
} from '../../shared/orcad-live-migration-recovery'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { resumeOrcadLiveMigration } from './orcad-live-migration-resume'

export type OrcadLiveMigrationContext = Pick<
  Parameters<typeof resumeOrcadLiveMigration>[0],
  'store' | 'runtime'
>
const selectorSchema = z.string().trim().min(1).max(1024)
const resumeSchema = z.object({
  selector: selectorSchema,
  migrationId: z.string().min(1).max(1024),
  mode: z.enum(['initial', 'recovery'])
})

export function listSelectedOrcadLiveMigrations(
  profileDirectory: string,
  store: OrcadLiveMigrationContext['store'],
  selector: string
): OrcadLiveMigrationProgress[] {
  const environment = resolveEnvironment(profileDirectory, selectorSchema.parse(selector))
  const cutovers = inspectOrcadLiveCutoverRecovery(profileDirectory, store)
  const retirements = inspectOrcadLiveRetirementRecovery(profileDirectory, store)
  return cutovers
    .filter(({ intent }) => intent.destinationEnvironmentId === environment.id)
    .map(({ intent, journal, state }) => {
      if (
        intent.liveTerminalBindings!.some(
          ({ identity }) => identity.destinationRuntimeId !== environment.runtimeId
        )
      ) {
        throw new Error('orcad_live_migration_destination_changed')
      }
      const migrationId = intent.manifest.migrationId
      const retirement = retirements.find(
        ({ record }) => record.release.cutover.manifest.migrationId === migrationId
      )
      return {
        migrationId,
        destinationEnvironmentId: environment.id,
        sourceSshTargetId: intent.manifest.source.sshTargetId,
        phase: journal?.phase ?? intent.phase,
        phaseEvidence: state,
        ...(retirement ? { profileState: retirement.state } : {}),
        receipts: retirement?.sourceCancellationReceipts ?? {
          recorded: 0,
          total: intent.liveTerminalBindings!.length
        },
        sourceRetirement:
          retirement?.state === 'profile-installed' &&
          retirement.completedCutover &&
          store.isOrcadLiveCompletionDurable(retirement.completedCutover)
            ? ('complete' as const)
            : ('pending' as const)
      }
    })
}

/** Desktop-owned selection; callers cannot supply manifests, identities, paths or host proofs. */
export async function resumeSelectedOrcadLiveMigration(
  profileDirectory: string,
  context: OrcadLiveMigrationContext,
  selection: OrcadLiveMigrationResumeSelection,
  signal: AbortSignal
): Promise<OrcadLiveMigrationProgress> {
  const args = resumeSchema.parse(selection)
  signal.throwIfAborted()
  if (!isPtyOwnershipTransferMutationEnabled()) {
    throw new Error('pty_ownership_transfer_mutation_disabled')
  }
  const selected = listSelectedOrcadLiveMigrations(
    profileDirectory,
    context.store,
    args.selector
  ).find(({ migrationId }) => migrationId === args.migrationId)
  if (!selected) {
    throw new Error('orcad_live_migration_selection_missing')
  }
  const result = await resumeOrcadLiveMigration({
    ...context,
    profileDirectory,
    migrationId: args.migrationId,
    signal,
    recoveryOnly: args.mode === 'recovery'
  })
  signal.throwIfAborted()
  return {
    ...selected,
    phase: result.phase,
    phaseEvidence: 'journal-retained',
    sourceRetirement: result.sourceRetirement,
    profileState: 'profile-installed',
    receipts: { recorded: result.receipts.length, total: selected.receipts.total }
  }
}
