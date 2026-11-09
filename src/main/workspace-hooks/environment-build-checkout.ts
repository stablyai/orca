// Orca Cloud environment builds (cloud/apps/sandbox-control image/env/environment-build.sh) install a
// repo's dependencies once and leave `<git common dir>/orca-env-deps` behind; every workspace created
// from the build gets those folders. Such a checkout needs no per-workspace setup script, so Orca
// does not nudge for one.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const MARKER = 'orca-env-deps'

/** The git common dir of `repoPath` (primary checkout or linked worktree), or null. Sync and cheap. */
function gitCommonDir(repoPath: string): string | null {
  const dotGit = join(repoPath, '.git')
  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) {
      return dotGit
    }
    // A linked worktree: `.git` is a file naming its gitdir, which names the common dir.
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
    if (!pointer) {
      return null
    }
    const gitDir = isAbsolute(pointer) ? pointer : resolve(repoPath, pointer)
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    return isAbsolute(common) ? common : resolve(gitDir, common)
  } catch {
    return null
  }
}

export function isEnvironmentBuildCheckout(repoPath: string): boolean {
  const common = gitCommonDir(repoPath)
  return common !== null && existsSync(join(common, MARKER))
}

/** Same check from a known common dir (the environment doctor already has it). */
export function hasEnvironmentBuildMarker(commonDir: string, root: string): boolean {
  const dir = isAbsolute(commonDir) ? commonDir : resolve(root, commonDir)
  return existsSync(join(dir, MARKER))
}
