import { readFile } from 'node:fs/promises'
import * as path from 'node:path'

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')

  try {
    const dotGitContents = await readFile(dotGitPath, 'utf-8')
    const match = dotGitContents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // `.git` is likely a directory in a non-worktree checkout.
  }

  return dotGitPath
}
