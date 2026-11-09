// Orca Cloud environment builds (cloud/apps/sandbox-control image/env/environment-build.sh) install a
// repo's dependencies once and leave `<git common dir>/orca-env-deps` behind; every workspace created
// from the build gets those folders. Such a checkout needs no per-workspace setup script, so Orca
// does not nudge for one.
import { access, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const MARKER = 'orca-env-deps'

/** The git common dir of `repoPath` (primary checkout or linked worktree), or null. */
async function gitCommonDir(repoPath: string): Promise<string | null> {
  const dotGit = join(repoPath, '.git')
  try {
    if ((await stat(dotGit)).isDirectory()) {
      return dotGit
    }
    // A linked worktree: `.git` is a file naming its gitdir, which names the common dir.
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim()
    if (!pointer) {
      return null
    }
    const gitDir = isAbsolute(pointer) ? pointer : resolve(repoPath, pointer)
    const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    return isAbsolute(common) ? common : resolve(gitDir, common)
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function isEnvironmentBuildCheckout(repoPath: string): Promise<boolean> {
  const common = await gitCommonDir(repoPath)
  return common !== null && (await exists(join(common, MARKER)))
}

/** Same check from a known common dir (the environment doctor already has it). */
export function hasEnvironmentBuildMarker(commonDir: string, root: string): Promise<boolean> {
  const dir = isAbsolute(commonDir) ? commonDir : resolve(root, commonDir)
  return exists(join(dir, MARKER))
}
