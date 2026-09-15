import { isAbsolute, resolve } from 'node:path'
import { getWorktreeSharedLinkPaths } from '../main/git/worktree-shared-directories'
import { findExistingWorktreeSymlinkPaths } from '../main/git/worktree-symlink-detection'
import { assertWorktreeMaterializationTarget } from '../main/ipc/worktree-materialization-target'
import type { GitExec } from './git-handler-ops'

export async function resolveRelayRemovableSharedLinks(
  git: GitExec,
  worktreePath: string,
  value: unknown
): Promise<string[]> {
  if (value === undefined) {
    return []
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('source' in value) ||
    typeof value.source !== 'string' ||
    !isAbsolute(value.source) ||
    !('paths' in value) ||
    !Array.isArray(value.paths) ||
    value.paths.length > 1000 ||
    value.paths.some((p) => typeof p !== 'string' || p.length > 4096)
  ) {
    throw new Error('Invalid shared-link removal request')
  }
  const candidates = getWorktreeSharedLinkPaths({ path: value.source, symlinkPaths: value.paths })
  const links = await findExistingWorktreeSymlinkPaths(worktreePath, candidates)
  if (!links.length) {
    return []
  }
  for (const link of links) {
    await assertWorktreeMaterializationTarget(worktreePath, resolve(worktreePath, link))
  }
  // A tracked symlink belongs to the checkout, even when its name is configured for sharing.
  const { stdout } = await git(
    ['--literal-pathspecs', 'ls-files', '-z', '--cached', '--', ...links],
    worktreePath
  )
  const tracked = new Set(stdout.split('\0'))
  return links.filter((link) => !tracked.has(link))
}
