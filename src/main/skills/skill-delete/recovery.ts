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

/**
 * A path-based delete has no install receipt — that absence is the reason this
 * feature exists — so replay is validated by containment and placement shape
 * instead of a receipt digest.
 *
 * `wslDistro` and `allowedRoots` are not extras: at startup there is no target,
 * no workspace, and no repo list to resolve either from, so a journal that
 * omits them cannot be replayed on WSL and cannot be validated at all.
 */
export type SkillDeleteJournalV1 = {
  schemaVersion: 1
  operation: 'delete'
  phase: 'prepared' | 'staging' | 'staged'
  /**
   * The `canonical` placement's own literal, pre-realpath directory path — the
   * same value the lock key is derived from, and the name the shared journal
   * scanner cross-checks against the file name.
   */
  canonicalPath: string
  /** Set when the files live in a WSL distro, so startup recovery can rebuild
   *  the guest filesystem with no target, workspace, or repo list to resolve
   *  from. Every path above is already in the spelling that filesystem takes. */
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
  // A sibling rename by construction: same parent, hidden name, our marker.
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
    // Roll forward: the skill is already gone from every discovered location.
    for (const move of staged) {
      await filesystem.remove(move.stagedPath)
    }
    // A receipt cleanup failure leaves the journal in place so startup can
    // retry it alongside the already-idempotent staged removals.
    await removeSkillInstallReceipt(stateDirectory, canonicalPath)
  } else {
    // Roll back in reverse of staging order, so a restored alias never points at
    // a canonical directory that does not exist yet. Indexed rather than
    // `toReversed()`: this module reaches the Node 18 relay bundle.
    let restoredEvery = true
    for (let index = staged.length - 1; index >= 0; index -= 1) {
      const move = staged[index]
      try {
        await filesystem.rename(move.stagedPath, move.sourcePath)
      } catch {
        // The journal records intent before each rename, so a recorded move may
        // never have been performed — and a retry re-walks moves an earlier
        // pass already restored. Both leave the staged path gone with nothing
        // to move back; counting that as failure would pin the journal forever
        // on the exact crash it exists to recover from. Any other failure keeps
        // the journal (with the other moves still restored): dropping it would
        // strand the staged path with no record startup could retry from.
        if (!(await skillStagedPathGone(move.stagedPath, filesystem))) {
          restoredEvery = false
        }
      }

      /** True only on positive proof of absence: an unanswerable inspection must keep
       *  the journal, never clear it. */
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
