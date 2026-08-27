import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SkillInstallResult, SkillPlacementResult } from '../../shared/skill-install-contract'
import { acquireSkillInstallLock, skillInstallLockPath } from './skill-install-lock'
import {
  readSkillInstallReceipt,
  removeSkillInstallReceipt,
  writeSkillStateFile,
  type SkillInstallReceiptV1
} from './skill-install-provenance'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from './skill-install-filesystem'
import { isRemovableSkillPlacement } from './skill-removable-placement'
import {
  recoverSkillRemovalTransaction,
  skillRemovalJournalPath,
  skillRemovalPathExists,
  type RemovalMove,
  type SkillRemovalJournalV1
} from './skill-remove-recovery'
import { recoverSkillPlacementTransaction } from './skill-placement-transaction'
import { recoverSkillInstallTransaction } from './skill-install-recovery'
import { historicalSuccessfulProviderRoots } from './skill-install-historical-provider-roots'

export {
  recoverSkillRemovalTransaction,
  skillRemovalJournalPath,
  type SkillRemovalJournalV1
} from './skill-remove-recovery'

export type LocalSkillRemovalInput = {
  operationId: string
  canonicalPath: string
  stateDirectory: string
  allowedProviderRoots: readonly string[]
  conflictResolution?: 'replace-and-discard-local' | 'cancel'
  filesystem?: SkillInstallFilesystem
}

export type SkillRemovalTransactionDependencies = {
  onJournalTransition?: (
    phase: SkillRemovalJournalV1['phase'],
    boundary: 'before' | 'after'
  ) => Promise<void>
}

function conflictResult(
  input: LocalSkillRemovalInput,
  receipt: SkillInstallReceiptV1 | null,
  kind: 'modified' | 'unowned' | 'external-link' | 'name-collision'
): SkillInstallResult {
  const code = `skill-removal-conflict-${kind}`
  return {
    operationId: input.operationId,
    status: 'conflict',
    name: basename(input.canonicalPath),
    packageDigest: receipt?.packageDigest ?? '',
    canonicalPath: input.canonicalPath,
    placements: [],
    conflict: { kind },
    errorCategory: code,
    failure: { category: 'conflict', code, retryable: false }
  }
}

async function inspectCanonicalRemoval(
  input: LocalSkillRemovalInput,
  receipt: SkillInstallReceiptV1 | null
): Promise<'missing' | 'owned' | 'modified' | 'unowned' | 'external-link' | 'name-collision'> {
  const stat = await lstat(input.canonicalPath).catch(() => null)
  if (!stat) {
    return receipt ? 'missing' : 'unowned'
  }
  if (!receipt) {
    return 'unowned'
  }
  if (stat.isSymbolicLink()) {
    return 'external-link'
  }
  if (!stat.isDirectory()) {
    return 'name-collision'
  }
  const observed = await (input.filesystem ?? nativeSkillInstallFilesystem)
    .observeSkill(input.canonicalPath, receipt.fileModes)
    .catch(() => null)
  return observed?.observedDigest === receipt.packageDigest ? 'owned' : 'modified'
}

async function persistRemovalJournal(
  path: string,
  journal: SkillRemovalJournalV1,
  dependencies: SkillRemovalTransactionDependencies
): Promise<void> {
  await dependencies.onJournalTransition?.(journal.phase, 'before')
  await writeSkillStateFile(path, journal)
  await dependencies.onJournalTransition?.(journal.phase, 'after')
}

export async function removeLocalSharedSkill(
  input: LocalSkillRemovalInput,
  dependencies: SkillRemovalTransactionDependencies = {}
): Promise<SkillInstallResult> {
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const releaseLock = await acquireSkillInstallLock({
    path: skillInstallLockPath(input.stateDirectory, input.canonicalPath)
  })
  try {
    const historicalReceipt = await readSkillInstallReceipt(
      input.stateDirectory,
      input.canonicalPath
    )
    filesystem.authorizeRoots?.(historicalSuccessfulProviderRoots(historicalReceipt))
    await recoverSkillRemovalTransaction(input.stateDirectory, input.canonicalPath, filesystem)
    await recoverSkillInstallTransaction(input.stateDirectory, input.canonicalPath, filesystem)
    await recoverSkillPlacementTransaction(input.stateDirectory, input.canonicalPath, filesystem)
    const receipt = await readSkillInstallReceipt(input.stateDirectory, input.canonicalPath)
    const state = await inspectCanonicalRemoval(input, receipt)
    if (!receipt) {
      return conflictResult(input, null, 'unowned')
    }
    if (state === 'unowned' || state === 'external-link' || state === 'name-collision') {
      return conflictResult(input, receipt, state)
    }
    if (state === 'modified' && input.conflictResolution !== 'replace-and-discard-local') {
      return conflictResult(input, receipt, 'modified')
    }

    const allowedProviderRoots = [
      ...input.allowedProviderRoots,
      ...historicalSuccessfulProviderRoots(receipt)
    ]

    const removedPlacements: SkillPlacementResult[] = []
    const skippedPlacements: SkillPlacementResult[] = []
    const moves: RemovalMove[] = []
    for (const placement of receipt.placements) {
      if (placement.topology === 'canonical-copy') {
        continue
      }
      if (
        await isRemovableSkillPlacement({
          placement,
          receipt,
          allowedProviderRoots,
          filesystem
        })
      ) {
        moves.push({
          sourcePath: placement.path,
          backupPath: join(
            dirname(placement.path),
            `.${basename(placement.path)}.orca-remove-backup-${randomUUID()}`
          ),
          placement,
          ...(placement.topology === 'provider-alias'
            ? { expectedAliasTarget: receipt.canonicalPath }
            : { expectedDigest: receipt.packageDigest })
        })
      } else if (await skillRemovalPathExists(placement.path)) {
        skippedPlacements.push({
          ...placement,
          status: 'skipped',
          errorCategory: 'skill-removal-placement-modified-or-unowned',
          failure: {
            category: 'conflict',
            code: 'skill-removal-placement-modified-or-unowned',
            retryable: false
          }
        })
      }
    }
    if (state !== 'missing') {
      const canonicalDigest = await filesystem
        .observeSkill(input.canonicalPath, receipt.fileModes)
        .then((observed) => observed.observedDigest)
        .catch(() => null)
      if (!canonicalDigest) {
        return conflictResult(input, receipt, 'modified')
      }
      moves.push({
        sourcePath: input.canonicalPath,
        backupPath: join(
          dirname(input.canonicalPath),
          `.${basename(input.canonicalPath)}.orca-remove-backup-${randomUUID()}`
        ),
        placement: {
          provider: 'agent-skills',
          path: input.canonicalPath,
          topology: 'canonical-copy',
          status: 'installed'
        },
        expectedDigest: canonicalDigest
      })
    }
    const journal: SkillRemovalJournalV1 = {
      schemaVersion: 1,
      operation: 'remove',
      phase: 'prepared',
      canonicalPath: input.canonicalPath,
      movedCount: 0,
      moves,
      receipt,
      allowedProviderRoots: [...new Set(allowedProviderRoots)]
    }
    const statePath = skillRemovalJournalPath(input.stateDirectory, input.canonicalPath)
    await persistRemovalJournal(statePath, journal, dependencies)
    for (const move of moves) {
      journal.movedCount += 1
      journal.phase = 'moving'
      await persistRemovalJournal(statePath, journal, dependencies)
      await filesystem.rename(move.sourcePath, move.backupPath)
      removedPlacements.push({ ...move.placement, status: 'removed' })
    }
    await removeSkillInstallReceipt(input.stateDirectory, input.canonicalPath)
    journal.phase = 'receipt-removed'
    await persistRemovalJournal(statePath, journal, dependencies)
    await recoverSkillRemovalTransaction(input.stateDirectory, input.canonicalPath, filesystem)
    return {
      operationId: input.operationId,
      status: skippedPlacements.length > 0 ? 'partial' : 'removed',
      name: basename(input.canonicalPath),
      packageDigest: receipt.packageDigest,
      canonicalPath: input.canonicalPath,
      placements: [...removedPlacements, ...skippedPlacements]
    }
  } catch (error) {
    await recoverSkillRemovalTransaction(
      input.stateDirectory,
      input.canonicalPath,
      filesystem
    ).catch(() => undefined)
    throw error
  } finally {
    await releaseLock()
  }
}
