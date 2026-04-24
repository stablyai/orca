import { symlink, mkdir, stat } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'

/** Create filesystem symlinks from the primary checkout into a freshly-created
 *  worktree for each configured path. Failures on individual paths are logged
 *  and skipped so a missing/stale entry never blocks worktree creation.
 *
 *  Each entry is interpreted relative to `primaryPath` and placed at the same
 *  relative location inside `worktreePath`. Nested paths (e.g.
 *  `apps/web/.env`) are supported — parent directories are created lazily. */
export async function createWorktreeSymlinks(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[]
): Promise<void> {
  for (const rawPath of paths) {
    const rel = rawPath.trim().replace(/^\/+/, '')
    if (!rel || isAbsolute(rel) || rel.split('/').includes('..')) {
      // Why: reject anything that could escape the primary checkout. Users
      // can only configure paths relative to the repo root; absolute paths
      // and `..` traversal are not supported.
      console.warn(`[worktree-symlinks] Skipping unsafe path "${rawPath}"`)
      continue
    }

    const source = resolve(primaryPath, rel)
    const target = resolve(worktreePath, rel)

    try {
      await stat(source)
    } catch {
      // Source doesn't exist in primary checkout — nothing to link to. This is
      // a common case for fresh clones where `node_modules` hasn't been
      // installed yet; silently skip rather than leaving a dangling symlink.
      continue
    }

    try {
      // Why: if a file/dir already exists at the target location (e.g.
      // git-tracked sibling with the same name), leave it alone rather than
      // clobber something the user didn't mean to replace.
      await stat(target)
      continue
    } catch {
      // Target does not exist — proceed with symlink creation.
    }

    try {
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target)
    } catch (error) {
      console.error(
        `[worktree-symlinks] Failed to symlink "${rel}" (${source} -> ${target}):`,
        error
      )
    }
  }
}
