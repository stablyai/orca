import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

function gitdirOfGitFile(contents: string): string | undefined {
  const match = /^gitdir:\s*(.+)$/i.exec(contents.split(/\r?\n/, 1)[0]?.trim() ?? '')
  return match?.[1]?.trim() || undefined
}

/** The admin entry a checkout's `.git` file names; the leftover of this removal still names the same one. */
export async function readCheckoutGitdirPointer(worktreePath: string): Promise<string | undefined> {
  try {
    const gitFile = join(worktreePath, '.git')
    return (await lstat(gitFile)).isFile()
      ? gitdirOfGitFile(await readFile(gitFile, 'utf8'))
      : undefined
  } catch {
    return undefined
  }
}
