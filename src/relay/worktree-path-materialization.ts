import { isAbsolute, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { expandTilde } from './context'
import { resolveWorktreeIncludePaths } from '../main/git/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../main/git/worktree-shared-directories'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from '../main/ipc/worktree-symlinks'
import { formatWorktreeIncludeCopyWarning } from '../main/ipc/worktree-include-copy-budget'
import type { WorktreePathMaterializationResult } from '../shared/worktree-path-materialization'

export async function materializeRelayWorktreePaths(
  params: Record<string, unknown>
): Promise<WorktreePathMaterializationResult> {
  const { source, target, linkedPaths } = params
  if (
    typeof source !== 'string' ||
    typeof target !== 'string' ||
    !isAbsolute(expandTilde(source)) ||
    !isAbsolute(expandTilde(target)) ||
    !Array.isArray(linkedPaths) ||
    linkedPaths.length > 1000 ||
    linkedPaths.some((entry) => typeof entry !== 'string' || entry.length > 4096)
  ) {
    throw new Error('Invalid worktree materialization request')
  }
  const [sourcePath, targetPath] = await Promise.all([
    realpath(resolve(expandTilde(source))),
    realpath(resolve(expandTilde(target)))
  ])
  if (
    sourcePath === targetPath ||
    !(await stat(sourcePath)).isDirectory() ||
    !(await stat(targetPath)).isDirectory()
  ) {
    throw new Error('Worktree materialization requires distinct source and target directories')
  }
  await createWorktreeLinkedPaths(sourcePath, targetPath, linkedPaths)
  const [sharedPaths, includePaths] = await Promise.all([
    resolveWorktreeSharedDirectories(sourcePath),
    resolveWorktreeIncludePaths(sourcePath)
  ])
  await createWorktreeSharedPaths(sourcePath, targetPath, sharedPaths)
  const skipped = await createWorktreeCopiedPaths(sourcePath, targetPath, includePaths)
  const warning = formatWorktreeIncludeCopyWarning(skipped)
  return { supported: true, ...(warning ? { warning } : {}) }
}
