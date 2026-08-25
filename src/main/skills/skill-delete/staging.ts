import { randomUUID } from 'node:crypto'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import type { SkillDeletePlacement } from '../../../shared/skill-delete-contract'
import { nativeSkillPathSemantics } from '../../../shared/skill-path-containment'
import type { SkillDeleteJournalMove } from './recovery'
import type { SkillInstallFilesystem } from '../skill-install-filesystem'
import { SKILL_FILE_NAME } from '../skill-root-file-walk'
import { skillDeleteStagedName } from './staging-names'

function api(): typeof pathPosix {
  return nativeSkillPathSemantics().sep === '\\' ? pathWin32 : pathPosix
}

/**
 * Aliases stage before the canonical directory, so plain reversal of the move
 * list is exactly the rollback order the design requires: canonical restored
 * first, then `alias-dir`, then `alias-file` symlinks last — a restored alias
 * never points at a canonical directory that does not exist yet.
 */
const STAGING_ORDER: Record<SkillDeletePlacement['kind'], number> = {
  'alias-file': 0,
  'alias-dir': 1,
  canonical: 2
}

/**
 * A staged sibling shares one parent directory with its source by construction,
 * so the rename cannot fail with `EXDEV` — there is no volume to cross. The one
 * failure that survives is staging a placement that is itself a mount point,
 * which fails with `EBUSY` and is reported per placement.
 */
export function planSkillDeleteMoves(
  placements: readonly SkillDeletePlacement[],
  toFilesystemPath: (path: string) => string
): SkillDeleteJournalMove[] {
  const path = api()
  return [...placements]
    .sort((left, right) => STAGING_ORDER[left.kind] - STAGING_ORDER[right.kind])
    .map((placement) => {
      // An `alias-file` stages only the symlinked SKILL.md, in place. Its
      // directory is never staged, because it has to survive when it holds
      // anything besides that symlink.
      const source =
        placement.kind === 'alias-file'
          ? path.join(toFilesystemPath(placement.path), SKILL_FILE_NAME)
          : toFilesystemPath(placement.path)
      return {
        sourcePath: source,
        stagedPath: path.join(
          path.dirname(source),
          skillDeleteStagedName(path.basename(source), randomUUID())
        ),
        kind: placement.kind
      }
    })
}

export type SkillDeleteStagingOutcome =
  | { status: 'staged' }
  | { status: 'rolled-back'; error: unknown }
  | { status: 'partial'; error: unknown; stagedPaths: string[] }

export async function stageSkillDeleteMoves(input: {
  moves: readonly SkillDeleteJournalMove[]
  filesystem: SkillInstallFilesystem
  onProgress: (movedCount: number) => Promise<void>
}): Promise<SkillDeleteStagingOutcome> {
  const staged: SkillDeleteJournalMove[] = []
  for (const move of input.moves) {
    // Record the intent before the rename, so a crash in between leaves a move
    // recovery treats as possibly-done rather than orphaning the directory.
    await input.onProgress(staged.length + 1)
    try {
      await input.filesystem.rename(move.sourcePath, move.stagedPath)
      staged.push(move)
    } catch (error) {
      const unrestored = await rollbackSkillDeleteMoves(staged, input.filesystem)
      return unrestored.length > 0
        ? { status: 'partial', error, stagedPaths: unrestored }
        : { status: 'rolled-back', error }
    }
  }
  return { status: 'staged' }
}

/** Returns the staged paths that could not be put back. */
export async function rollbackSkillDeleteMoves(
  staged: readonly SkillDeleteJournalMove[],
  filesystem: SkillInstallFilesystem
): Promise<string[]> {
  const unrestored: string[] = []
  // Indexed rather than `toReversed()`: the delete modules reach the Node 18
  // relay bundle, where the ES2023 array-copy methods do not exist.
  for (let index = staged.length - 1; index >= 0; index -= 1) {
    const move = staged[index]
    try {
      await filesystem.rename(move.stagedPath, move.sourcePath)
    } catch {
      // Neither fully restored nor fully removed. Reported as `partial` with the
      // staged path so the result band can say where the files actually are,
      // rather than `failed`, which would wrongly imply nothing changed.
      unrestored.push(move.stagedPath)
    }
  }
  return unrestored
}

export type SkillDeleteRemovalOutcome = { removedPaths: string[]; unremoved: string[] }

export async function removeStagedSkillDeleteMoves(
  moves: readonly SkillDeleteJournalMove[],
  filesystem: SkillInstallFilesystem
): Promise<SkillDeleteRemovalOutcome> {
  const path = api()
  const removedPaths: string[] = []
  const unremoved: string[] = []
  for (const move of moves) {
    try {
      await filesystem.remove(move.stagedPath)
      removedPaths.push(move.sourcePath)
      if (move.kind === 'alias-file') {
        await removeDirectoryIfEmpty(path.dirname(move.sourcePath), filesystem)
      }
    } catch {
      unremoved.push(move.stagedPath)
    }
  }
  return { removedPaths, unremoved }
}

/** Matches the model's guarantee: a directory holding anything besides the
 *  removed symlink is left in place, because "not shared with another
 *  placement" is not the same guarantee as "contains nothing else". */
async function removeDirectoryIfEmpty(
  directory: string,
  filesystem: SkillInstallFilesystem
): Promise<void> {
  if (!filesystem.listEntries) {
    return
  }
  const listing = await filesystem.listEntries([directory]).catch(() => null)
  if (listing?.get(directory)?.length === 0) {
    await filesystem.remove(directory).catch(() => undefined)
  }
}
