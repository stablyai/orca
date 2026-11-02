import { rm } from 'node:fs/promises'
import { join, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { readNodeFileWithinLimit } from '../../../shared/node-bounded-file-reader'
import {
  SKILL_DELETE_PLACEMENT_KINDS,
  type SkillDeletePlacementKind
} from '../../../shared/skill-delete-contract'
import { nativeSkillPathSemantics, skillPathInside } from '../../../shared/skill-path-containment'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from '../skill-install-filesystem'
import {
  removeSkillInstallReceipt,
  skillInstallStateKey,
  writeSkillStateFile
} from '../skill-install-provenance'
import { isSkillDeleteStagedName } from './staging-names'

const JOURNAL_MAX_BYTES = 4 * 1024 * 1024

export type SkillDeleteJournalMove = {
  sourcePath: string
  stagedPath: string
  kind: SkillDeletePlacementKind
}

/** Without install receipts, validate replay by containment/placement. Persist distro and roots because startup has no workspace or target from which to reconstruct them. */
export type SkillDeleteJournalV1 = {
  schemaVersion: 1
  operation: 'delete'
  phase: 'prepared' | 'staging' | 'staged'
  /** Literal canonical-placement directory; lock and journal filename use this spelling. */
  canonicalPath: string
  /** Startup rebuilds the guest filesystem from this distro; journal paths already use its accepted spelling. */
  wslDistro: string | null
  allowedRoots: string[]
  movedCount: number
  moves: SkillDeleteJournalMove[]
}

export function skillDeleteJournalPath(stateDirectory: string, canonicalPath: string): string {
  return join(stateDirectory, 'delete-journals', `${skillInstallStateKey(canonicalPath)}.json`)
}

function validMove(move: unknown, journal: SkillDeleteJournalV1): move is SkillDeleteJournalMove {
  if (typeof move !== 'object' || move === null) {
    return false
  }
  const candidate: Partial<SkillDeleteJournalMove> = move
  if (
    typeof candidate.sourcePath !== 'string' ||
    typeof candidate.stagedPath !== 'string' ||
    !SKILL_DELETE_PLACEMENT_KINDS.includes(candidate.kind as SkillDeletePlacementKind)
  ) {
    return false
  }
  const semantics = nativeSkillPathSemantics()
  const api = semantics.sep === '\\' ? pathWin32 : pathPosix
  return (
    api.dirname(candidate.sourcePath) === api.dirname(candidate.stagedPath) &&
    isSkillDeleteStagedName(
      api.basename(candidate.sourcePath),
      api.basename(candidate.stagedPath)
    ) &&
    journal.allowedRoots.some((root) => skillPathInside(root, candidate.sourcePath!, semantics))
  )
}

function isDeleteJournal(value: unknown, canonicalPath: string): value is SkillDeleteJournalV1 {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const journal: Partial<SkillDeleteJournalV1> = value
  if (
    journal.schemaVersion !== 1 ||
    journal.operation !== 'delete' ||
    journal.canonicalPath !== canonicalPath ||
    (journal.phase !== 'prepared' && journal.phase !== 'staging' && journal.phase !== 'staged') ||
    (typeof journal.wslDistro !== 'string' && journal.wslDistro !== null) ||
    !Array.isArray(journal.allowedRoots) ||
    !journal.allowedRoots.every((root) => typeof root === 'string') ||
    !Array.isArray(journal.moves) ||
    !Number.isInteger(journal.movedCount)
  ) {
    return false
  }
  const candidate = journal as SkillDeleteJournalV1
  if (candidate.movedCount < 0 || candidate.movedCount > candidate.moves.length) {
    return false
  }
  const sources = new Set(candidate.moves.map((move: SkillDeleteJournalMove) => move?.sourcePath))
  return (
    sources.size === candidate.moves.length &&
    candidate.moves.every((move) => validMove(move, candidate))
  )
}

export async function writeSkillDeleteJournal(
  stateDirectory: string,
  journal: SkillDeleteJournalV1
): Promise<void> {
  await writeSkillStateFile(skillDeleteJournalPath(stateDirectory, journal.canonicalPath), journal)
}

export async function readSkillDeleteRecoveryJournal(
  stateDirectory: string,
  canonicalPath: string
): Promise<SkillDeleteJournalV1 | null> {
  try {
    const parsed: unknown = JSON.parse(
      (
        await readNodeFileWithinLimit(
          skillDeleteJournalPath(stateDirectory, canonicalPath),
          JOURNAL_MAX_BYTES
        )
      ).buffer.toString('utf8')
    )
    if (!isDeleteJournal(parsed, canonicalPath)) {
      throw new Error('skill-delete-journal-invalid')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function recoverSkillDeleteTransaction(
  stateDirectory: string,
  canonicalPath: string,
  filesystem: SkillInstallFilesystem = nativeSkillInstallFilesystem
): Promise<void> {
  const journal = await readSkillDeleteRecoveryJournal(stateDirectory, canonicalPath)
  if (!journal) {
    return
  }
  const staged = journal.moves.slice(0, journal.movedCount)
  if (journal.phase === 'staged') {
    for (const move of staged) {
      await filesystem.remove(move.stagedPath)
    }
    // Keep journal on receipt-cleanup failure so startup retries after idempotent staged removals.
    await removeSkillInstallReceipt(stateDirectory, canonicalPath)
  } else {
    // Restore canonical before aliases by reversing staging; indexed iteration supports the Node 18 relay.
    let restoredEvery = true
    for (let index = staged.length - 1; index >= 0; index -= 1) {
      const move = staged[index]
      try {
        await filesystem.rename(move.stagedPath, move.sourcePath)
      } catch {
        // Absent staging means an unperformed intent or prior restore. Any other failure retains the journal for retry so parked content cannot be stranded.
        if (!(await skillStagedPathGone(move.stagedPath, filesystem))) {
          restoredEvery = false
        }
      }

      /** Require positive absence proof; unavailable inspection must retain the journal. */
      async function skillStagedPathGone(
        stagedPath: string,
        filesystem: SkillInstallFilesystem
      ): Promise<boolean> {
        const inspections = await filesystem.inspectPaths?.([stagedPath]).catch(() => null)
        return inspections?.get(stagedPath)?.kind === 'missing'
      }
    }
    if (!restoredEvery) {
      return
    }
  }
  await rm(skillDeleteJournalPath(stateDirectory, canonicalPath), { force: true })
}
