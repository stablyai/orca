import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/file-access/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

/** Orca's homes to delete in, and roots (the user's import folder) no deletion may reach. */
export type RolloutHomes = { homes: readonly string[]; protectedRoots: readonly string[] }

/** Null when absent; a folder that can't be resolved for another reason throws. */
async function realpathUnlessAbsent(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/**
 * Where the protected roots really are, since a linked folder can put a home's names inside one.
 * A root that is itself a home Orca deletes from is that home, so it isn't protected; a root that
 * can't be resolved for a reason other than being gone throws, since its names can't be told apart.
 */
export async function resolveProtectedRoots({
  homes,
  protectedRoots
}: RolloutHomes): Promise<string[]> {
  if (protectedRoots.length === 0) {
    return []
  }
  // A home that can't be resolved just matches no root, so the root stays protected.
  const realHomes = new Set(
    (await Promise.all(homes.map((home) => realpath(home).catch(() => null))))
      .filter((home) => home !== null)
      .map(normalizeRuntimePathForComparison)
  )
  const resolved: string[] = []
  for (const root of protectedRoots) {
    const realRoot = await realpathUnlessAbsent(root)
    if (realRoot && !realHomes.has(normalizeRuntimePathForComparison(realRoot))) {
      resolved.push(realRoot)
    }
  }
  return resolved
}

/** False when the name's real folder is inside a protected root; checked last, right before removal. */
export async function isOutsideProtectedRoots(
  path: string,
  protectedRoots: readonly string[]
): Promise<boolean> {
  if (protectedRoots.length === 0) {
    return true
  }
  const realFolder = await realpathUnlessAbsent(dirname(path))
  return (
    realFolder !== null && !protectedRoots.some((root) => isPathInsideOrEqual(root, realFolder))
  )
}
