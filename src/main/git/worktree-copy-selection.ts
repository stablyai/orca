import { isDescendantOrEqual } from '../ipc/filesystem-path-containment'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import {
  parseWorktreeIncludeFile,
  isWorktreeCopyPathList,
  isWorktreeCopyPath
} from '../../shared/worktree-copy-paths'
import { checkIgnoredPaths } from './check-ignored-paths'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

type CopySelection = { paths: string[]; notices: string[] }

export function collapseWorktreePaths(root: string, paths: readonly string[]): string[] {
  const parents: string[] = []
  for (const path of [...new Set(paths)].sort(
    (a, b) => a.length - b.length || a.localeCompare(b)
  )) {
    if (!parents.some((parent) => worktreePathsOverlap(root, parent, path))) {
      parents.push(path)
    }
  }
  return parents
}

export function worktreePathsOverlap(root: string, left: string, right: string): boolean {
  const a = resolve(root, left),
    b = resolve(root, right)
  return relative(a, b) === '' || isDescendantOrEqual(a, b) || isDescendantOrEqual(b, a)
}

export async function resolveWorktreeCopySelection(
  source: string,
  personal: readonly string[]
): Promise<CopySelection> {
  let project: string[] = []
  try {
    const file = join(source, '.worktreeinclude')
    const info = await lstat(file)
    if (!info.isFile() || info.size > 256 * 1024) {
      throw new Error('.worktreeinclude must be an ordinary file no larger than 256 KiB.')
    }
    project = parseWorktreeIncludeFile(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  if (!isWorktreeCopyPathList(personal)) {
    throw new Error(
      'Repository settings: use at most 1,000 literal repository-relative paths, without patterns or traversal.'
    )
  }
  const invalidProject = project.filter((path) => !isWorktreeCopyPath(path))
  project = project.filter(isWorktreeCopyPath).slice(0, 1000)
  const candidates = [...new Set([...personal, ...project])]
  const existing = await mapWithConcurrency(candidates, 8, async (path) => {
    try {
      await lstat(join(source, path))
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      return null
    }
  })
  const missing = candidates.filter((_, index) => existing[index] === null)
  const notices =
    invalidProject.length > 0
      ? [`${invalidProject.length} unsupported .worktreeinclude entries were skipped.`]
      : []
  notices.push(
    ...missing.slice(0, 5).map((path) => {
      const name = path.length > 160 ? `${path.slice(0, 157)}…` : path
      return `${name}: nothing to copy from the primary checkout.`
    })
  )
  if (missing.length > 5) {
    notices.push(`${missing.length - 5} more selected paths were absent.`)
  }
  const present = existing.filter((path): path is string => path !== null)
  const ignored = new Set(present.length ? await checkIgnoredPaths(source, present) : [])
  for (const path of present) {
    if (!ignored.has(path)) {
      throw new Error(`${path}: files to copy must be ignored by Git in the primary checkout.`)
    }
  }
  return { paths: collapseWorktreePaths(source, present), notices }
}
