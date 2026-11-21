import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

function gitdirOfGitFile(contents: string): string | undefined {
  const match = /^gitdir:\s*(.+)$/i.exec(contents.split(/\r?\n/, 1)[0]?.trim() ?? '')
  return match?.[1]?.trim() || undefined
}

/** The admin entry a checkout's `.git` file names plus that file's inode (not the device, which can change across boots): Git reuses admin names, so the name alone cannot tell two checkouts at one path apart. */
export async function readCheckoutMarkerIdentity(
  worktreePath: string
): Promise<string | undefined> {
  try {
    const gitFile = join(worktreePath, '.git')
    const entry = await lstat(gitFile, { bigint: true })
    const gitdir = entry.isFile() ? gitdirOfGitFile(await readFile(gitFile, 'utf8')) : undefined
    return gitdir ? `${gitdir}#${entry.ino}` : undefined
  } catch {
    return undefined
  }
}
