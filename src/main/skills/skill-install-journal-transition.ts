import { writeSkillStateFile } from './skill-install-provenance'
import type { SkillInstallJournalV1 } from './skill-install-recovery'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'

export type SkillInstallJournalBoundary = 'before' | 'after'

export type SkillInstallTransactionDependencies = {
  onJournalTransition?: (
    phase: SkillInstallJournalV1['phase'],
    boundary: SkillInstallJournalBoundary
  ) => Promise<void>
  placementTransaction?: {
    prepare(previous: SkillInstallReceiptV1 | null, receipt: SkillInstallReceiptV1): Promise<void>
    commit(receipt: SkillInstallReceiptV1): Promise<SkillInstallReceiptV1>
    finish(receipt: SkillInstallReceiptV1): Promise<void>
  }
}

export async function persistSkillInstallJournalTransition(
  statePath: string,
  journal: SkillInstallJournalV1,
  dependencies: SkillInstallTransactionDependencies
): Promise<void> {
  await dependencies.onJournalTransition?.(journal.phase, 'before')
  await writeSkillStateFile(statePath, journal)
  await dependencies.onJournalTransition?.(journal.phase, 'after')
}
