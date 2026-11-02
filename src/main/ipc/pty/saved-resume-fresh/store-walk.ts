import type { Dirent } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** `missing` only after the whole relevant store was read; any doubt is `unknown`. */
export type StorePresence = 'found' | 'missing' | 'unknown'

/** One check's whole allowance; any exhausted limit makes the answer unknown, never missing. */
export type StoreReadBudget = {
  entries: number
  directories: number
  deadline: number
}

export function newStoreReadBudget(now = Date.now()): StoreReadBudget {
  return { entries: 20_000, directories: 2_000, deadline: now + 3_000 }
}

export class StoreReadIncomplete extends Error {}

/** Streams one directory's entries, charging the budget; read failures propagate. */
export async function* listStoreDirectory(
  dir: string,
  budget: StoreReadBudget
): AsyncGenerator<Dirent> {
  if ((budget.directories -= 1) < 0 || Date.now() > budget.deadline) {
    throw new StoreReadIncomplete()
  }
  for await (const entry of await opendir(dir)) {
    if ((budget.entries -= 1) < 0) {
      throw new StoreReadIncomplete()
    }
    yield entry
  }
}

function isDefinitiveAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Walks `root` up to `depth` directories down for a file `matches` names. A symlinked
 *  directory cannot be surveyed, so it keeps a miss unknown. */
export async function findStoreFile(
  root: string,
  depth: number,
  matches: (name: string) => boolean,
  budget: StoreReadBudget,
  options: { absentRootIsEmpty?: boolean } = {}
): Promise<StorePresence> {
  const stack = [{ dir: root, depth }]
  let surveyed = true
  let listedAny = false
  try {
    while (stack.length > 0) {
      const next = stack.pop()!
      for await (const entry of listStoreDirectory(next.dir, budget)) {
        listedAny = true
        if (entry.isDirectory()) {
          if (next.depth > 0) {
            stack.push({ dir: join(next.dir, entry.name), depth: next.depth - 1 })
          }
        } else if (matches(entry.name)) {
          return 'found'
        } else if (entry.isSymbolicLink() && next.depth > 0) {
          surveyed = false
        }
      }
    }
  } catch (error) {
    const rootAbsent = !listedAny && stack.length === 0 && isDefinitiveAbsence(error)
    return rootAbsent && options.absentRootIsEmpty ? 'missing' : 'unknown'
  }
  return surveyed ? 'missing' : 'unknown'
}

/** A regular file is found; only a definitive absence is missing. */
export async function statStoreFile(path: string): Promise<StorePresence> {
  try {
    return (await stat(path)).isFile() ? 'found' : 'unknown'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'missing' : 'unknown'
  }
}
