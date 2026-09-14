import { rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { SkillPlacementResult } from '../../shared/skill-install-contract'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from './skill-install-filesystem'
import {
  writeSkillInstallReceipt,
  writeSkillStateFile,
  type SkillInstallReceiptV1
} from './skill-install-provenance'
import { isRemovableSkillPlacement } from './skill-removable-placement'
import { reconcileSkillProviderPlacement } from './skill-placement-reconciliation'
import {
  readSkillPlacementRecoveryJournal,
  skillPlacementJournalPath,
  type SkillPlacementJournalActionV1,
  type SkillPlacementJournalV1
} from './skill-placement-recovery-journal'
import {
  placementBackupMatchesPrevious,
  placementIsAlias,
  placementMatchesDigest,
  placementPathExists,
  settleDesiredPlacementArtifacts
} from './skill-placement-artifact-recovery'

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

async function settleDeselectedAction(
  journal: SkillPlacementJournalV1,
  action: SkillPlacementJournalActionV1,
  filesystem: SkillInstallFilesystem,
  allowedProviderRoots: readonly string[]
): Promise<SkillPlacementResult | null> {
  if (await placementPathExists(action.backupPath)) {
    if (!(await placementBackupMatchesPrevious(journal, action, filesystem))) {
      throw new Error('skill-placement-recovery-conflict')
    }
    await filesystem.remove(action.backupPath)
  }
  const previous = journal.previousReceipt?.placements.find(
    (placement) => normalizedPath(placement.path) === normalizedPath(action.destinationPath)
  )
  if (!previous || !(await placementPathExists(action.destinationPath))) {
    return null
  }
  const removable = await isRemovableSkillPlacement({
    placement: previous,
    receipt: journal.previousReceipt!,
    allowedProviderRoots,
    filesystem
  })
  if (removable) {
    await filesystem.rename(action.destinationPath, action.backupPath)
    return null
  }
  return {
    ...previous,
    status: 'skipped',
    errorCategory: 'skill-removal-placement-modified-or-unowned',
    failure: {
      category: 'conflict',
      code: 'skill-removal-placement-modified-or-unowned',
      retryable: false
    }
  }
}

export async function recoverSkillPlacementTransaction(
  stateDirectory: string,
  canonicalPath: string,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem,
  options: { finalize?: boolean; signal?: AbortSignal } = {}
): Promise<SkillInstallReceiptV1 | null> {
  const journal = await readSkillPlacementRecoveryJournal(stateDirectory, canonicalPath)
  if (!journal) {
    return null
  }
  if (!(await placementMatchesDigest(canonicalPath, journal.packageDigest, journal, filesystem))) {
    if (
      journal.previousReceipt &&
      (await placementMatchesDigest(
        canonicalPath,
        journal.previousReceipt.packageDigest,
        journal,
        filesystem,
        journal.previousReceipt.fileModes ?? []
      ))
    ) {
      await Promise.all(
        journal.actions.flatMap((action) => [
          filesystem.remove(action.stagingPath),
          filesystem.remove(action.backupPath)
        ])
      )
      await rm(skillPlacementJournalPath(stateDirectory, canonicalPath), { force: true })
      return journal.previousReceipt
    }
    if (
      !journal.previousReceipt &&
      !(await placementPathExists(canonicalPath)) &&
      !(
        await Promise.all(
          journal.actions.flatMap((action) => [
            placementPathExists(action.stagingPath),
            placementPathExists(action.backupPath)
          ])
        )
      ).some(Boolean)
    ) {
      await rm(skillPlacementJournalPath(stateDirectory, canonicalPath), { force: true })
      return null
    }
    throw new Error('skill-placement-canonical-mismatch')
  }
  const allowedProviderRoots = journal.actions.map((action) => action.rootPath)
  const placements: SkillPlacementResult[] = [
    {
      provider: 'agent-skills',
      path: canonicalPath,
      topology: 'canonical-copy',
      status: 'installed'
    }
  ]
  for (const action of journal.actions) {
    if (!action.desired) {
      const skipped = await settleDeselectedAction(
        journal,
        action,
        filesystem,
        allowedProviderRoots
      )
      if (skipped) {
        placements.push(skipped)
      }
      continue
    }
    if (options.signal?.aborted) {
      placements.push({
        provider: action.provider,
        path: action.destinationPath,
        topology: 'independent-copy',
        status: 'skipped',
        errorCategory: 'skill-placement-cancelled',
        failure: {
          category: 'cancelled',
          code: 'skill-placement-cancelled',
          retryable: true
        }
      })
      continue
    }
    const recoveredArtifacts = await settleDesiredPlacementArtifacts(journal, action, filesystem)
    if (
      recoveredArtifacts &&
      (await placementPathExists(action.destinationPath)) &&
      (await placementMatchesDigest(
        action.destinationPath,
        journal.packageDigest,
        journal,
        filesystem
      ))
    ) {
      placements.push({
        provider: action.provider,
        path: action.destinationPath,
        topology: (await placementIsAlias(canonicalPath, action.destinationPath, filesystem))
          ? 'provider-alias'
          : 'independent-copy',
        status: 'unchanged'
      })
      continue
    }
    const destination = {
      provider: action.provider as never,
      rootPath: action.rootPath,
      readsCanonicalRoot: false
    }
    const placement = await reconcileSkillProviderPlacement({
      canonicalPath,
      skillName: basename(canonicalPath),
      destination,
      previousReceipt: journal.previousReceipt,
      packageDigest: journal.packageDigest,
      fileModes: journal.fileModes,
      filesystem,
      transaction: { stagingPath: action.stagingPath, backupPath: action.backupPath },
      ...(journal.wslDistro ? { targetPlatform: 'linux' as const } : {})
    })
    if (placement) {
      placements.push(placement)
    }
  }
  const receipt = { ...journal.receipt, placements, providers: journal.providers }
  await writeSkillInstallReceipt(stateDirectory, receipt)
  await writeSkillStateFile(skillPlacementJournalPath(stateDirectory, canonicalPath), {
    ...journal,
    receipt
  })
  if (options.finalize !== false) {
    await finishSkillPlacementTransaction(stateDirectory, canonicalPath, filesystem)
  }
  return receipt
}

export async function finishSkillPlacementTransaction(
  stateDirectory: string,
  canonicalPath: string,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem
): Promise<void> {
  const journal = await readSkillPlacementRecoveryJournal(stateDirectory, canonicalPath)
  if (!journal) {
    return
  }
  await Promise.all(
    journal.actions.map(async (action) => {
      if (action.desired) {
        await settleDesiredPlacementArtifacts(journal, action, filesystem)
      }
      await filesystem.remove(action.stagingPath)
      if (await placementPathExists(action.backupPath)) {
        if (!(await placementBackupMatchesPrevious(journal, action, filesystem))) {
          throw new Error('skill-placement-recovery-conflict')
        }
        await filesystem.remove(action.backupPath)
      }
    })
  )
  await rm(skillPlacementJournalPath(stateDirectory, canonicalPath), { force: true })
}
