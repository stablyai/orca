import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { MultiRepoWorkspaceError } from '../../../shared/multi-repo-workspace'
import { sanitizeWorktreeName } from '../../ipc/worktree-logic'

const MAX_ROOT_SUFFIX = 100

/** Atomic exclusive mkdir: a taken name (including a case-only twin on case-insensitive disks) gets -2, -3. */
export async function allocateMultiRepoRoot(
  workspaceDir: string,
  workspaceName: string
): Promise<string> {
  if (!isAbsolute(workspaceDir)) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_root_unavailable',
      'The workspace directory must be an absolute path.'
    )
  }
  const baseName = sanitizeWorktreeName(workspaceName)
  await mkdir(workspaceDir, { recursive: true })
  for (let suffix = 1; suffix <= MAX_ROOT_SUFFIX; suffix += 1) {
    const candidate = join(workspaceDir, suffix === 1 ? baseName : `${baseName}-${suffix}`)
    const rel = relative(workspaceDir, candidate)
    if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new MultiRepoWorkspaceError('multi_repo_root_unavailable', 'Invalid workspace name.')
    }
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if (isErrnoCode(error, 'EEXIST')) {
        continue
      }
      throw error
    }
  }
  throw new MultiRepoWorkspaceError(
    'multi_repo_root_unavailable',
    'Could not find a free folder for this workspace. Pick a different name.'
  )
}

/** Leaf names are the repo folder names; collisions inside one workspace compare case-insensitively. */
export function allocateMemberDirNames(repoPaths: readonly string[]): string[] {
  const taken = new Set<string>()
  return repoPaths.map((repoPath) => {
    const leaf = repoPath.split(/[\\/]/).findLast(Boolean) ?? 'project'
    const base = sanitizeWorktreeName(leaf.replace(/\.git$/, ''))
    let candidate = base
    for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) {
      candidate = `${base}-${suffix}`
    }
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
