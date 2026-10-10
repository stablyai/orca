import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  acquireSkillInstallLock,
  reclaimDeadSkillInstallLocks,
  skillInstallLockPath
} from './skill-install-lock'
import { recoverPendingSkillExtractions } from './skill-extraction-recovery'
import { skillInstallStateKey } from './skill-install-provenance'
import {
  readSkillInstallRecoveryJournal,
  recoverSkillInstallTransaction
} from './skill-install-recovery'
import {
  readSkillRemovalRecoveryJournal,
  recoverSkillRemovalTransaction
} from './skill-remove-recovery'
import { startSkillPhaseOperation } from './skill-operation-observability'
import { WslSkillInstallFilesystem } from './skill-wsl-install-filesystem'
import { readSkillPlacementRecoveryJournal } from './skill-placement-recovery-journal'
import {
  readSkillDeleteRecoveryJournal,
  recoverSkillDeleteTransaction
} from './skill-delete/recovery'
import { recoverSkillPlacementTransaction } from './skill-placement-transaction'

const MAX_PENDING_TRANSACTION_JOURNALS = 64
const MAX_TRANSACTION_JOURNAL_BYTES = 4 * 1024 * 1024

type PendingTransaction = {
  canonicalPath: string
  journalKey: string
  install: boolean
  removal: boolean
  placement: boolean
  delete: boolean
}

export type SkillTransactionStartupRecoveryReport = {
  scanned: number
  recovered: number
  orphanedExtractionsRecovered: number
  orphanedLocksReclaimed: number
  failures: { journalKey: string; code: string }[]
  truncated: boolean
}

function failureCode(error: unknown): string {
  return error instanceof Error && /^skill-[a-z0-9-]+$/.test(error.message)
    ? error.message
    : 'skill-transaction-startup-recovery-failed'
}

async function scanJournalDirectory(
  stateDirectory: string,
  directoryName: 'journals' | 'removal-journals' | 'placement-journals' | 'delete-journals'
): Promise<{
  candidates: { canonicalPath: string; journalKey: string }[]
  failures: { journalKey: string; code: string }[]
  truncated: boolean
}> {
  const entries = await readdir(join(stateDirectory, directoryName), { withFileTypes: true }).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
  )
  const journalEntries = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
  const candidates: { canonicalPath: string; journalKey: string }[] = []
  const failures: { journalKey: string; code: string }[] = []
  for (const entry of journalEntries.slice(0, MAX_PENDING_TRANSACTION_JOURNALS)) {
    const journalKey = entry.name.slice(0, -'.json'.length)
    try {
      const parsed: unknown = JSON.parse(
        (
          await readNodeFileWithinLimit(
            join(stateDirectory, directoryName, entry.name),
            MAX_TRANSACTION_JOURNAL_BYTES
          )
        ).buffer.toString('utf8')
      )
      const canonicalPath =
        parsed && typeof parsed === 'object' && 'canonicalPath' in parsed
          ? (parsed as { canonicalPath?: unknown }).canonicalPath
          : null
      if (
        typeof canonicalPath !== 'string' ||
        canonicalPath.length > 32_768 ||
        skillInstallStateKey(canonicalPath) !== journalKey
      ) {
        throw new Error('skill-transaction-journal-invalid')
      }
      candidates.push({ canonicalPath, journalKey })
    } catch (error) {
      failures.push({ journalKey, code: failureCode(error) })
    }
  }
  return {
    candidates,
    failures,
    truncated: journalEntries.length > MAX_PENDING_TRANSACTION_JOURNALS
  }
}

function pendingTransactions(
  installs: readonly { canonicalPath: string; journalKey: string }[],
  removals: readonly { canonicalPath: string; journalKey: string }[]
): PendingTransaction[] {
  const pending = new Map<string, PendingTransaction>()
  const add = (
    candidate: { canonicalPath: string; journalKey: string },
    kind: 'install' | 'removal'
  ): void => {
    const current = pending.get(candidate.canonicalPath) ?? {
      canonicalPath: candidate.canonicalPath,
      journalKey: candidate.journalKey,
      install: false,
      removal: false,
      placement: false,
      delete: false
    }
    current[kind] = true
    pending.set(candidate.canonicalPath, current)
  }
  removals.forEach((candidate) => add(candidate, 'removal'))
  installs.forEach((candidate) => add(candidate, 'install'))
  return [...pending.values()]
}

/** Merged after the map-based dedupe so a kind that shares a canonical path with
 *  an install or removal joins that transaction rather than racing it. */
function mergeJournalCandidates(
  pending: PendingTransaction[],
  candidates: readonly { canonicalPath: string; journalKey: string }[],
  kind: 'placement' | 'delete'
): void {
  for (const candidate of candidates) {
    const current = pending.find((entry) => entry.canonicalPath === candidate.canonicalPath)
    if (current) {
      current[kind] = true
      continue
    }
    pending.push({
      ...candidate,
      install: false,
      removal: false,
      placement: false,
      delete: false,
      [kind]: true
    })
  }
}

async function recoverPendingSkillTransactionsUnobserved(
  stateDirectory: string
): Promise<SkillTransactionStartupRecoveryReport> {
  const [installs, removals, placements, deletes, extractions, locks] = await Promise.all([
    scanJournalDirectory(stateDirectory, 'journals'),
    scanJournalDirectory(stateDirectory, 'removal-journals'),
    scanJournalDirectory(stateDirectory, 'placement-journals'),
    scanJournalDirectory(stateDirectory, 'delete-journals'),
    recoverPendingSkillExtractions(stateDirectory),
    reclaimDeadSkillInstallLocks(stateDirectory)
  ])
  const report: SkillTransactionStartupRecoveryReport = {
    scanned:
      installs.candidates.length +
      removals.candidates.length +
      placements.candidates.length +
      deletes.candidates.length +
      extractions.scanned,
    recovered: extractions.recovered,
    orphanedExtractionsRecovered: extractions.recovered,
    orphanedLocksReclaimed: locks.reclaimed,
    failures: [
      ...installs.failures,
      ...removals.failures,
      ...placements.failures,
      ...deletes.failures,
      ...extractions.failures
    ],
    truncated:
      installs.truncated ||
      removals.truncated ||
      placements.truncated ||
      deletes.truncated ||
      extractions.truncated ||
      locks.truncated
  }
  const pending = pendingTransactions(installs.candidates, removals.candidates)
  mergeJournalCandidates(pending, placements.candidates, 'placement')
  mergeJournalCandidates(pending, deletes.candidates, 'delete')
  for (const pendingTransaction of pending) {
    let releaseLock: (() => Promise<void>) | null = null
    try {
      releaseLock = await acquireSkillInstallLock({
        path: skillInstallLockPath(stateDirectory, pendingTransaction.canonicalPath)
      })
      const installJournal = pendingTransaction.install
        ? await readSkillInstallRecoveryJournal(stateDirectory, pendingTransaction.canonicalPath)
        : null
      const removalJournal = pendingTransaction.removal
        ? await readSkillRemovalRecoveryJournal(stateDirectory, pendingTransaction.canonicalPath)
        : null
      const placementJournal = pendingTransaction.placement
        ? await readSkillPlacementRecoveryJournal(stateDirectory, pendingTransaction.canonicalPath)
        : null
      const deleteJournal = pendingTransaction.delete
        ? await readSkillDeleteRecoveryJournal(stateDirectory, pendingTransaction.canonicalPath)
        : null
      const distros = new Set(
        [
          installJournal?.receipt.wslDistro,
          removalJournal?.receipt.wslDistro,
          placementJournal?.wslDistro,
          deleteJournal?.wslDistro
        ].filter((distro): distro is string => Boolean(distro))
      )
      if (distros.size > 1 || (distros.size && process.platform !== 'win32')) {
        throw new Error('skill-transaction-wsl-recovery-unavailable')
      }
      const distro = [...distros][0]
      const filesystem = distro
        ? new WslSkillInstallFilesystem(distro, [
            dirname(pendingTransaction.canonicalPath),
            ...(removalJournal?.allowedProviderRoots ?? []),
            ...(placementJournal?.actions.map((action) => action.rootPath) ?? [])
          ])
        : undefined
      // Why explicit rather than only widening the constructor list: the delete
      // journal is the sole record of which roots its moves are allowed to
      // touch, and replay must be authorized for them before it operates.
      if (deleteJournal) {
        filesystem?.authorizeRoots(deleteJournal.allowedRoots)
      }
      if (removalJournal) {
        await recoverSkillRemovalTransaction(
          stateDirectory,
          pendingTransaction.canonicalPath,
          filesystem
        )
        report.recovered += 1
      }
      if (installJournal) {
        await recoverSkillInstallTransaction(
          stateDirectory,
          pendingTransaction.canonicalPath,
          filesystem
        )
        report.recovered += 1
      }
      if (placementJournal) {
        await recoverSkillPlacementTransaction(
          stateDirectory,
          pendingTransaction.canonicalPath,
          filesystem
        )
        report.recovered += 1
      }
      if (deleteJournal) {
        await recoverSkillDeleteTransaction(
          stateDirectory,
          pendingTransaction.canonicalPath,
          filesystem
        )
        report.recovered += 1
      }
    } catch (error) {
      report.failures.push({
        journalKey: pendingTransaction.journalKey,
        code: failureCode(error)
      })
    } finally {
      await releaseLock?.().catch((error) => {
        report.failures.push({
          journalKey: pendingTransaction.journalKey,
          code: failureCode(error)
        })
      })
    }
  }
  return report
}

export async function recoverPendingSkillTransactions(
  stateDirectory: string
): Promise<SkillTransactionStartupRecoveryReport> {
  const operation = startSkillPhaseOperation({ phase: 'recovery', destination: 'startup' })
  try {
    const report = await recoverPendingSkillTransactionsUnobserved(stateDirectory)
    operation.complete({
      status: report.failures.length || report.truncated ? 'partial' : 'complete',
      scannedCount: report.scanned,
      recoveredCount: report.recovered,
      failureCount: report.failures.length,
      orphanCount: report.orphanedExtractionsRecovered + report.orphanedLocksReclaimed,
      truncated: report.truncated
    })
    return report
  } catch (error) {
    operation.fail(error)
    throw error
  }
}
