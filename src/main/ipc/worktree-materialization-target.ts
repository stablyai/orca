import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isDescendantOrEqual } from './filesystem-path-containment'

/** Refuse existing ancestor links, including links back into the source checkout. */
export async function assertWorktreeMaterializationTarget(
  root: string,
  target: string
): Promise<void> {
  const resolvedRoot = resolve(root)
  if (target === resolvedRoot || !isDescendantOrEqual(target, resolvedRoot)) {
    throw new Error('Materialization target must be below the workspace root')
  }
  await realpath(resolvedRoot)
  for (let parent = dirname(target); parent !== resolvedRoot; parent = dirname(parent)) {
    try {
      const entry = await lstat(parent)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error('Materialization target has a linked or non-directory ancestor')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }
}
