import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/file-access/wsl-paths'
import type { NestedRepoGitIdentity } from './nested-repo-scan-rules'

async function canonicalCommonDir(dirPath: string): Promise<string> {
  const resolved = await realpath(dirPath).catch(() => resolve(dirPath))
  return normalizeRuntimePathForComparison(resolved)
}

function resolveGitPointerPath(baseDir: string, pointer: string): string {
  const trimmed = pointer.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return win32.normalize(trimmed)
  }
  if (trimmed.startsWith('/')) {
    const wsl = parseWslUncPath(baseDir)
    if (wsl) {
      return toWindowsWslUncPath(trimmed, wsl.distro)
    }
    return trimmed
  }
  if (isAbsolute(trimmed)) {
    return trimmed
  }
  return resolve(baseDir, trimmed)
}

async function readGitDirFromFile(dotGitPath: string, worktreeDir: string): Promise<string | null> {
  try {
    const text = await readFile(dotGitPath, 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(text)
    if (!match?.[1]) {
      return null
    }
    return resolveGitPointerPath(worktreeDir, match[1])
  } catch {
    return null
  }
}

async function readCommonDirFromGitDir(gitDir: string): Promise<string> {
  try {
    const raw = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    if (raw) {
      return resolveGitPointerPath(gitDir, raw)
    }
  } catch {
    // Non-worktree gitdirs (e.g. submodules or direct bare pointers) have no commondir file.
  }
  return gitDir
}

/** Resolve a discovered candidate's Git common directory from filesystem metadata without spawning Git. */
export async function resolveLocalGitCommonDir(
  dirPath: string
): Promise<NestedRepoGitIdentity | null> {
  const dotGitPath = join(dirPath, '.git')
  const dotGitStat = await stat(dotGitPath).catch(() => null)
  if (dotGitStat?.isDirectory()) {
    return { commonDir: await canonicalCommonDir(dotGitPath), kind: 'main' }
  }
  if (dotGitStat?.isFile()) {
    const gitDir = await readGitDirFromFile(dotGitPath, dirPath)
    if (!gitDir) {
      return null
    }
    const commonDir = await readCommonDirFromGitDir(gitDir)
    return { commonDir: await canonicalCommonDir(commonDir), kind: 'linked' }
  }
  const [head, objects, refs] = await Promise.all(
    ['HEAD', 'objects', 'refs'].map((name) => stat(join(dirPath, name)).catch(() => null))
  )
  if (head?.isFile() && objects?.isDirectory() && refs?.isDirectory()) {
    return { commonDir: await canonicalCommonDir(dirPath), kind: 'bare' }
  }
  return null
}
