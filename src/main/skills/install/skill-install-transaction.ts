import {
  inspectExtractedPackage,
  type LocalExtractedSkillPackage
} from './skill-extracted-package-inspection'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillInstallResult } from '../../../shared/skill-install-contract'
import type { SkillPackageManifestV1 } from '../../../shared/skill-package-manifest'
import {
  acquireSkillInstallLock,
  skillInstallLockPath
} from '../transaction-state/skill-install-lock'
import {
  inspectSkillCanonicalState,
  type SkillCanonicalState
} from './skill-canonical-install-state'
import {
  readSkillInstallReceipt,
  writeSkillInstallReceipt,
  writeSkillStateFile,
  type SkillInstallReceiptV1
} from '../transaction-state/skill-install-provenance'
import { recoverSkillRemovalTransaction } from '../managed-remove/skill-remove-recovery'
import {
  cleanSkillInstallJournalFiles,
  recoverSkillInstallTransaction,
  skillInstallDestinationMatches,
  skillInstallJournalPath,
  skillInstallPathExists,
  type SkillInstallJournalV1
} from './skill-install-recovery'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from '../filesystem/skill-install-filesystem'
import {
  beginSkillExtractionRecovery,
  finishSkillExtractionRecovery
} from '../transaction-state/skill-extraction-recovery'
import { SKILL_INSTALL_CANCELLED_FAILURE } from '../../../shared/skill-install-failure'
import { SkillInstallOperationError } from './skill-install-operation-error'
import {
  createSkillInstallReceipt,
  skillInstallConflictResult,
  skillInstallFailureResult,
  skillInstallReplacementAllowed,
  skillInstallUnchangedResult
} from './skill-install-transaction-result'
import { settleObservedSkillTransactionRecovery } from '../transaction-state/skill-transaction-recovery-observability'
import { recoverSkillPlacementTransaction } from '../provider-placement/skill-placement-transaction'
import { historicalSuccessfulProviderRoots } from '../provider-placement/skill-install-historical-provider-roots'

export type SkillInstallTransactionDependencies = {
  placementTransaction?: {
    prepare(previous: SkillInstallReceiptV1 | null, receipt: SkillInstallReceiptV1): Promise<void>
    commit(receipt: SkillInstallReceiptV1): Promise<SkillInstallReceiptV1>
    finish(receipt: SkillInstallReceiptV1): Promise<void>
  }
}

export type LocalSkillInstallInput = {
  operationId: string
  archivePath: string
  destinationRoot: string
  stateDirectory: string
  scope: 'global' | 'workspace'
  destinationIdentity: string
  hostIdentity: string
  expectedArchiveSha256?: string
  expectedPackageDigest?: string
  expectedPackageId?: string
  expectedVersionId?: string
  sourceBundleDigest?: string
  conflictResolution?: 'replace-unmodified' | 'replace-and-discard-local' | 'cancel'
  filesystem?: SkillInstallFilesystem
  wslDistro?: string
  signal?: AbortSignal
  lockTimeoutMs?: number
}

export type LocalSkillInstallPreview = {
  manifest: SkillPackageManifestV1
  canonicalPath: string
  currentState: SkillCanonicalState
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE)
  }
}

export async function previewLocalSkillPackage(
  input: LocalSkillInstallInput
): Promise<LocalSkillInstallPreview> {
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const recovery = await beginSkillExtractionRecovery(
    input.stateDirectory,
    input.destinationRoot,
    input.wslDistro
  )
  try {
    const extracted = await inspectExtractedPackage(input, recovery.extractionPath)
    return await previewLocalExtractedSkillPackage(input, extracted)
  } finally {
    await finishSkillExtractionRecovery(input.stateDirectory, recovery, filesystem)
  }
}

export async function previewLocalExtractedSkillPackage(
  input: LocalSkillInstallInput,
  extracted: LocalExtractedSkillPackage
): Promise<LocalSkillInstallPreview> {
  const canonicalPath = join(input.destinationRoot, extracted.manifest.name)
  const receipt = await readSkillInstallReceipt(input.stateDirectory, canonicalPath)
  return {
    manifest: extracted.manifest,
    canonicalPath,
    currentState: await inspectSkillCanonicalState({
      canonicalPath,
      manifest: extracted.manifest,
      receipt,
      filesystem: input.filesystem
    })
  }
}

export async function installLocalSkillPackage(
  input: LocalSkillInstallInput,
  dependencies: SkillInstallTransactionDependencies = {}
): Promise<SkillInstallResult> {
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const recovery = await beginSkillExtractionRecovery(
    input.stateDirectory,
    input.destinationRoot,
    input.wslDistro
  )
  try {
    const extracted = await inspectExtractedPackage(input, recovery.extractionPath)
    return await installLocalExtractedSkillPackage(input, extracted, dependencies)
  } finally {
    await finishSkillExtractionRecovery(input.stateDirectory, recovery, filesystem)
  }
}

export async function installLocalExtractedSkillPackage(
  input: LocalSkillInstallInput,
  extracted: LocalExtractedSkillPackage,
  dependencies: SkillInstallTransactionDependencies = {}
): Promise<SkillInstallResult> {
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const canonicalPath = join(input.destinationRoot, extracted.manifest.name)
  let releaseLock: (() => Promise<void>) | null = null
  let journal: SkillInstallJournalV1 | null = null
  try {
    throwIfCancelled(input.signal)
    releaseLock = await acquireSkillInstallLock({
      path: skillInstallLockPath(input.stateDirectory, canonicalPath),
      timeoutMs: input.lockTimeoutMs
    })
    const historicalReceipt = await readSkillInstallReceipt(input.stateDirectory, canonicalPath)
    filesystem.authorizeRoots?.(historicalSuccessfulProviderRoots(historicalReceipt))
    await recoverSkillRemovalTransaction(input.stateDirectory, canonicalPath, filesystem)
    await recoverSkillInstallTransaction(input.stateDirectory, canonicalPath, filesystem)
    await recoverSkillPlacementTransaction(input.stateDirectory, canonicalPath, filesystem)
    throwIfCancelled(input.signal)
    const previous = await readSkillInstallReceipt(input.stateDirectory, canonicalPath)
    const state = await inspectSkillCanonicalState({
      canonicalPath,
      manifest: extracted.manifest,
      receipt: previous,
      filesystem
    })
    let receipt = createSkillInstallReceipt({
      request: input,
      manifest: extracted.manifest,
      archiveSha256: extracted.archiveSha256,
      canonicalPath,
      previous
    })
    if (state.kind === 'unchanged') {
      await dependencies.placementTransaction?.prepare(previous, receipt)
      throwIfCancelled(input.signal)
      receipt = (await dependencies.placementTransaction?.commit(receipt)) ?? receipt
      await writeSkillInstallReceipt(input.stateDirectory, receipt)
      await dependencies.placementTransaction?.finish(receipt)
      return skillInstallUnchangedResult(input, extracted.manifest, canonicalPath, receipt)
    }
    if (!skillInstallReplacementAllowed(state, input)) {
      return skillInstallConflictResult(input.operationId, extracted.manifest, state)
    }
    await dependencies.placementTransaction?.prepare(previous, receipt)
    throwIfCancelled(input.signal)
    const transactionId = randomUUID()
    const stagingPath = join(
      input.destinationRoot,
      `.${extracted.manifest.name}.orca-staging-${transactionId}`
    )
    const backupPath = join(
      input.destinationRoot,
      `.${extracted.manifest.name}.orca-backup-${transactionId}`
    )
    const destinationExists = await skillInstallPathExists(canonicalPath)
    const backupDigest = 'digest' in state ? (state.digest ?? null) : null
    if (destinationExists && !backupDigest) {
      return skillInstallConflictResult(input.operationId, extracted.manifest, state)
    }
    journal = {
      schemaVersion: 1,
      operation: 'install',
      phase: 'prepared',
      canonicalPath,
      extractionPath: extracted.extractionPath,
      stagingPath,
      backupPath,
      backupDigest,
      stagingFileModes: extracted.manifest.files,
      backupFileModes: previous?.fileModes ?? extracted.manifest.files,
      receipt
    }
    const statePath = skillInstallJournalPath(input.stateDirectory, canonicalPath)
    await writeSkillStateFile(statePath, journal)
    await filesystem.rename(join(extracted.extractionPath, 'skill'), stagingPath)
    throwIfCancelled(input.signal)
    const commitState = await inspectSkillCanonicalState({
      canonicalPath,
      manifest: extracted.manifest,
      receipt: previous,
      filesystem
    })
    if (JSON.stringify(commitState) !== JSON.stringify(state)) {
      await recoverSkillInstallTransaction(input.stateDirectory, canonicalPath, filesystem)
      journal = null
      return skillInstallConflictResult(
        input.operationId,
        extracted.manifest,
        commitState,
        'skill-install-conflict-stale-preview'
      )
    }
    if (destinationExists) {
      await filesystem.rename(canonicalPath, backupPath)
      journal.phase = 'backup-created'
      await writeSkillStateFile(statePath, journal)
      throwIfCancelled(input.signal)
    }
    await filesystem.rename(stagingPath, canonicalPath)
    journal.phase = 'canonical-placed'
    await writeSkillStateFile(statePath, journal)
    if (
      !(await skillInstallDestinationMatches(
        canonicalPath,
        extracted.manifest.packageDigest,
        filesystem,
        extracted.manifest.files
      ))
    ) {
      throw new Error('skill-install-committed-digest-mismatch')
    }
    await writeSkillInstallReceipt(input.stateDirectory, receipt)
    receipt = (await dependencies.placementTransaction?.commit(receipt)) ?? receipt
    await writeSkillInstallReceipt(input.stateDirectory, receipt)
    journal.receipt = receipt
    journal.phase = 'receipt-published'
    await writeSkillStateFile(statePath, journal)
    await dependencies.placementTransaction?.finish(receipt)
    await cleanSkillInstallJournalFiles(journal, filesystem)
    journal.phase = 'complete'
    await writeSkillStateFile(statePath, journal)
    await rm(statePath, { force: true })
    return {
      operationId: input.operationId,
      status: previous ? 'updated' : 'installed',
      name: extracted.manifest.name,
      packageDigest: extracted.manifest.packageDigest,
      canonicalPath,
      placements: receipt.placements
    }
  } catch (error) {
    if (journal) {
      await settleObservedSkillTransactionRecovery({
        rollback: journal.phase === 'backup-created',
        recover: () =>
          recoverSkillInstallTransaction(input.stateDirectory, canonicalPath, filesystem)
      })
    }
    const result = skillInstallFailureResult(input, extracted.manifest, canonicalPath, error)
    if (result) {
      return result
    }
    throw error
  } finally {
    await filesystem.remove(extracted.extractionPath)
    await releaseLock?.()
  }
}
