import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getPetsDir, isSafeId } from './pet-storage-paths'

/** How long an unrecognised entry is left alone.
 *
 *  A pet is written to disk before it reaches the persisted list, so anything
 *  written recently may simply be in flight. Only entries that have had a full
 *  day to be claimed are treated as abandoned. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

export type PetDirEntry = { name: string; mtimeMs: number }

/** The id an entry belongs to, or null if it is not one of ours at all. */
function petIdOf(name: string): string | null {
  const base = name.endsWith('.tmp') ? name.slice(0, -'.tmp'.length) : name
  const id = base.includes('.') ? base.slice(0, base.indexOf('.')) : base
  return isSafeId(id) ? id : null
}

/** Picks out the pet files nothing points at any more.
 *
 *  Deliberately conservative: it only ever proposes entries that are shaped
 *  like a pet id, unclaimed, and old. Anything it cannot account for — a
 *  stray file, a folder someone else wrote — it leaves where it is. */
export function orphanedPetEntries(
  entries: readonly PetDirEntry[],
  knownIds: ReadonlySet<string>,
  now: number
): string[] {
  return entries
    .filter((entry) => {
      const id = petIdOf(entry.name)
      if (!id) {
        return false
      }
      if (now - entry.mtimeMs < ORPHAN_GRACE_MS) {
        return false
      }
      // Why: a `.tmp` is a write that never finished. Its id may well be live,
      // but the finished bundle sits beside it under the plain name.
      return entry.name.endsWith('.tmp') || !knownIds.has(id)
    })
    .map((entry) => entry.name)
}

/** Deletes the pet files nothing points at any more.
 *
 *  Removing a pet from the list already deletes its bytes; this is for the
 *  cases where that never got the chance to run — a crash between writing the
 *  bundle and persisting the list, or a profile restored without it. Best
 *  effort throughout: a pet that cannot be removed is left for next time
 *  rather than turned into a startup failure. */
export async function sweepOrphanedPets(knownIds: Iterable<string>): Promise<void> {
  const root = getPetsDir()
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  const stats = await Promise.all(
    names.map(async (name): Promise<PetDirEntry | null> => {
      try {
        return { name, mtimeMs: (await stat(join(root, name))).mtimeMs }
      } catch {
        // Vanished between the listing and the stat; nothing to sweep.
        return null
      }
    })
  )
  const entries = stats.filter((entry): entry is PetDirEntry => entry !== null)
  await Promise.all(
    orphanedPetEntries(entries, new Set(knownIds), Date.now()).map(async (name) => {
      try {
        await rm(join(root, name), { recursive: true, force: true })
      } catch (error) {
        console.warn('[pet-overlay] could not sweep orphaned pet', name, error)
      }
    })
  )
}
