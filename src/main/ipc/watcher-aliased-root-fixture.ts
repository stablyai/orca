import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type AliasedWatcherRoot = {
  /** Temp directory holding both spellings; remove it with `removeAliasedWatcherRoot`. */
  base: string
  /** The directory that actually holds the files. */
  realRoot: string
  /** The spelling a caller would subscribe with — resolves to `realRoot`. */
  aliasRoot: string
}

/**
 * Creates a directory reachable under two spellings, the way a developer's
 * `~/code -> /Volumes/…` link or a `C:\dev` junction makes a worktree reachable.
 *
 * Windows uses a junction rather than a symlink: creating a directory symlink
 * there needs elevation or Developer Mode, while a junction needs neither and is
 * what users actually have. `realpath` resolves both identically.
 */
export async function createAliasedWatcherRoot(prefix: string): Promise<AliasedWatcherRoot> {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const realRoot = join(base, 'real')
  const aliasRoot = join(base, 'alias')
  await mkdir(realRoot, { recursive: true })
  await symlink(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
  return { base, realRoot, aliasRoot }
}

export async function removeAliasedWatcherRoot(root: AliasedWatcherRoot | null): Promise<void> {
  if (root) {
    await rm(root.base, { recursive: true, force: true })
  }
}
