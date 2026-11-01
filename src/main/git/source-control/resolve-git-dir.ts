import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveGitMetadataPath, resolveWorktreeHostPath } from '../../../shared/git-metadata-path'
import { parseGitdirMarkerPayload } from '../../../shared/gitdir-marker-payload'
import type { GitRuntimeOptions } from '../git-runtime-options'

export async function resolveGitDir(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<string> {
  // Translate guest paths before Node reads or resolves relative pointers in the Win32 namespace.
  const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options) ?? worktreePath
  const dotGitPath = path.join(hostWorktreePath, '.git')

  try {
    const gitDir = parseGitdirMarkerPayload(await readFile(dotGitPath, 'utf-8'))
    if (gitDir) {
      return resolveGitMetadataPath(hostWorktreePath, gitDir, options) ?? dotGitPath
    }
  } catch {}

  return dotGitPath
}
