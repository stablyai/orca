import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { parseGitdirMarkerPayload } from '../../../shared/gitdir-marker-payload'

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')

  try {
    const gitDir = parseGitdirMarkerPayload(await readFile(dotGitPath, 'utf-8'))
    if (gitDir) {
      return path.resolve(worktreePath, gitDir)
    }
  } catch {
    // `.git` is likely a directory in a non-worktree checkout.
  }

  return dotGitPath
}
