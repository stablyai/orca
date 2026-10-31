// Prune unused fork remotes after removal; reconciliation reuses these ownership and usage predicates.

import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { parseGitHubOwnerRepo } from '../github/gh-utils'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { iterateProcessOutputLines } from '../../shared/process-output-field-scanner'

export type GitRemoteExec = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>
export type WorktreePushTargetStore = Pick<Store, 'getAllWorktreeMeta'> &
  Partial<Pick<Store, 'setWorktreeMeta' | 'getRepos' | 'getAllWorktreeMetaForHost'>>

export function sameGitHubRemoteUrl(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const parsedLeft = parseGitHubOwnerRepo(left)
  const parsedRight = parseGitHubOwnerRepo(right)
  return Boolean(
    parsedLeft &&
    parsedRight &&
    parsedLeft.owner.toLowerCase() === parsedRight.owner.toLowerCase() &&
    parsedLeft.repo.toLowerCase() === parsedRight.repo.toLowerCase()
  )
}

export type WorktreeMetaReferencingRemote = { worktreeId: string; meta: WorktreeMeta }

export function findWorktreeMetaReferencingRemote(
  store: WorktreePushTargetStore,
  repoId: string,
  target: Pick<GitPushTarget, 'remoteName' | 'remoteUrl'>
): WorktreeMetaReferencingRemote[] {
  return Object.entries(store.getAllWorktreeMeta())
    .filter(([worktreeId, meta]) => {
      // Remotes are repo-local; another repo's metadata must not retain this fork remote.
      if (getRepoIdFromWorktreeId(worktreeId) !== repoId || !meta.pushTarget) {
        return false
      }
      const otherRemoteUrl = meta.pushTarget.remoteUrl
      const targetRemoteUrl = target.remoteUrl
      return (
        meta.pushTarget.remoteName === target.remoteName ||
        (typeof otherRemoteUrl === 'string' &&
          typeof targetRemoteUrl === 'string' &&
          sameGitHubRemoteUrl(otherRemoteUrl, targetRemoteUrl))
      )
    })
    .map(([worktreeId, meta]) => ({ worktreeId, meta }))
}

function isPushTargetUsedByAnotherWorktree(
  store: WorktreePushTargetStore,
  removedWorktreeId: string,
  target: GitPushTarget
): boolean {
  const removedRepoId = getRepoIdFromWorktreeId(removedWorktreeId)
  return findWorktreeMetaReferencingRemote(store, removedRepoId, target).some(
    ({ worktreeId }) => worktreeId !== removedWorktreeId
  )
}

export type BranchConfigMatch = { branchName: string }

export async function hasBranchConfigUsingRemote(
  execGit: GitRemoteExec,
  repoPath: string,
  target: Pick<GitPushTarget, 'remoteName' | 'remoteUrl'>,
  options: { requireExistingBranch?: boolean } = {}
): Promise<boolean> {
  let stdout: string
  try {
    ;({ stdout } = await execGit(
      ['config', '--get-regexp', '^branch\\..*\\.(remote|pushRemote)$'],
      repoPath
    ))
  } catch {
    return false
  }
  const matches: BranchConfigMatch[] = []
  // Avoid line-array allocation for potentially large Git config output.
  for (const line of iterateProcessOutputLines(stdout)) {
    const parsed = parseBranchRemoteConfigLine(line)
    if (parsed && (parsed.value === target.remoteName || parsed.value === target.remoteUrl)) {
      matches.push({ branchName: parsed.branchName })
    }
  }
  if (matches.length === 0) {
    return false
  }
  if (!options.requireExistingBranch) {
    return true
  }
  return branchesExist(
    execGit,
    repoPath,
    matches.map((match) => match.branchName)
  )
}

async function branchesExist(
  execGit: GitRemoteExec,
  repoPath: string,
  branchNames: string[]
): Promise<boolean> {
  try {
    const { stdout } = await execGit(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      repoPath
    )
    const existingBranches = new Set(iterateProcessOutputLines(stdout))
    return branchNames.some((branchName) => existingBranches.has(branchName))
  } catch {
    return false
  }
}

function parseBranchRemoteConfigLine(line: string): { branchName: string; value: string } | null {
  let index = 0
  while (index < line.length && isBranchConfigSeparator(line.charCodeAt(index))) {
    index += 1
  }
  const keyStart = index
  while (index < line.length && !isBranchConfigSeparator(line.charCodeAt(index))) {
    index += 1
  }
  const key = line.slice(keyStart, index)
  while (index < line.length && isBranchConfigSeparator(line.charCodeAt(index))) {
    index += 1
  }
  if (index >= line.length) {
    return null
  }

  const valueStart = index
  let valueEnd = line.length
  while (valueEnd > valueStart && isBranchConfigSeparator(line.charCodeAt(valueEnd - 1))) {
    valueEnd -= 1
  }
  if (valueStart >= valueEnd) {
    return null
  }
  const branchName = extractBranchNameFromConfigKey(key)
  return branchName ? { branchName, value: line.slice(valueStart, valueEnd) } : null
}

// Branch names can contain dots; strip only the known remote/pushRemote suffix.
function extractBranchNameFromConfigKey(key: string): string | null {
  const prefix = 'branch.'
  if (!key.startsWith(prefix)) {
    return null
  }
  const rest = key.slice(prefix.length)
  const lastDot = rest.lastIndexOf('.')
  if (lastDot <= 0) {
    return null
  }
  const suffix = rest.slice(lastDot + 1)
  if (suffix !== 'remote' && suffix !== 'pushRemote') {
    return null
  }
  return rest.slice(0, lastDot)
}

function isBranchConfigSeparator(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

// Deferred materialization may omit store flags; read the repo-local Orca-created marker too.
async function remoteHasOrcaProvenance(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteName: string
): Promise<boolean> {
  try {
    const { stdout } = await execGit(
      ['config', '--get', `remote.${remoteName}.orca-created`],
      repoPath
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function cleanupUnusedWorktreePushTargetRemoteWithExec(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec
): Promise<void> {
  if (!target?.remoteUrl || target.remoteName === 'origin' || target.remoteName === 'upstream') {
    return
  }
  if (
    !target.remoteCreated &&
    !(await remoteHasOrcaProvenance(execGit, repoPath, target.remoteName))
  ) {
    return
  }
  if (isPushTargetUsedByAnotherWorktree(store, removedWorktreeId, target)) {
    return
  }
  if (await hasBranchConfigUsingRemote(execGit, repoPath, target)) {
    return
  }

  let configuredRemoteUrl: string
  try {
    configuredRemoteUrl = (
      await execGit(['remote', 'get-url', target.remoteName], repoPath)
    ).stdout.trim()
  } catch {
    return
  }
  if (!sameGitHubRemoteUrl(configuredRemoteUrl, target.remoteUrl)) {
    return
  }

  await execGit(['remote', 'remove', target.remoteName], repoPath)
}
