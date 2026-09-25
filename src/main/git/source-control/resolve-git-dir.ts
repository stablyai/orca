import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveGitMetadataPath, resolveWorktreeHostPath } from '../../../shared/git-metadata-path'
import { parseGitdirMarkerPayload } from '../../../shared/gitdir-marker-payload'
import type { GitRuntimeOptions } from '../git-runtime-options'

export async function resolveGitDir(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<string> {
  // Why: git in a WSL distro reports the worktree in the guest namespace, but this read and the
  // pointer resolve below both run in the Windows main process, where that spelling names nothing.
  // A relative pointer (`worktree.useRelativePaths`) resolves against it too, so a guest-spelled
  // base would make Win32 resolve it drive-relative.
  // Null only for an empty path; the caller's spelling keeps the pre-existing fallback.
  const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options) ?? worktreePath
  const dotGitPath = path.join(hostWorktreePath, '.git')

  try {
    const gitDir = parseGitdirMarkerPayload(await readFile(dotGitPath, 'utf-8'))
    if (gitDir) {
      return resolveGitMetadataPath(hostWorktreePath, gitDir, options) ?? dotGitPath
    }
  } catch {
    // `.git` is likely a directory in a non-worktree checkout.
  }

  return dotGitPath
}
