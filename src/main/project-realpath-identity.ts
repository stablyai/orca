import { realpath } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'

async function realpathKey(path: string): Promise<string | null> {
  try {
    return normalizeRuntimePathForComparison(await realpath(path))
  } catch {
    return null
  }
}

/** Resolve symlink aliases so the same checkout cannot be registered twice. */
export async function findProjectAtSameRealPath<T extends { path: string }>(
  projects: readonly T[],
  path: string
): Promise<T | null> {
  if (projects.length === 0) {
    return null
  }
  const target = await realpathKey(path)
  if (!target) {
    return null
  }
  const keys = await Promise.all(projects.map((project) => realpathKey(project.path)))
  const index = keys.indexOf(target)
  return index === -1 ? null : projects[index]
}
