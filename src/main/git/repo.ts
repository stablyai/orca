import { basename } from 'node:path'
import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import { buildHostedRemoteCommitUrl, buildHostedRemoteFileUrl } from './hosted-remote-url'
import {
  DEFAULT_BASE_REF_PROBE_TIMEOUT_MS,
  getDefaultBaseRef,
  getDefaultBaseRefAsync,
  gitExecOptions,
  type LocalGitExecOptions
} from './repo-default-base-ref'
import { gitExecFileAsync, gitExecFileSync } from './runner'

export {
  isGitRepo,
  getGitRepoRoot,
  getLinkedWorktreeMainRepoRoot,
  normalizeGitRepoRootForInputPath
} from './repo-detection'
export {
  DEFAULT_BASE_REF_PROBES,
  getDefaultBaseRef,
  getBaseRefDefault,
  resolveDefaultBaseRefViaExec,
  resolveDefaultBaseRefWithLocalGit
} from './repo-default-base-ref'
export type { GitExec } from './repo-default-base-ref'
export {
  buildSearchBaseRefsArgv,
  mergeBaseRefSearchResultGroups,
  searchBaseRefs,
  searchBaseRefDetails,
  parseAndFilterSearchRefDetails,
  normalizeRefSearchQuery
} from './repo-base-ref-search'
export { getBranchConflictKind } from './repo-branch-conflict'
export type { BranchConflictKind } from './repo-branch-conflict'
export { isForEachRefExcludeUnsupportedError } from '../../shared/git-ref-command-capabilities'

/** Get a human-readable name for the repo from its path. */
export function getRepoName(path: string): string {
  const name = basename(path)
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

/** Get the remote origin URL, or null if not set. */
export function getRemoteUrl(path: string): string | null {
  try {
    return gitExecFileSync(['remote', 'get-url', 'origin'], { cwd: path }).trim()
  } catch {
    return null
  }
}

/** Return the symmetric commit delta, or null when Git cannot prove it. */
export async function getRemoteDrift(
  repoPath: string,
  localRef: string,
  remoteRef: string,
  options: LocalGitExecOptions = {}
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
      {
        ...gitExecOptions(repoPath, options),
        timeout: DEFAULT_BASE_REF_PROBE_TIMEOUT_MS
      }
    )
    const counts = parseGitRevListAheadBehindCounts(stdout)
    if (counts.status !== 'ok') {
      return null
    }
    return { ahead: counts.ahead, behind: counts.behind }
  } catch {
    return null
  }
}

/** Return recent subjects on the remote side of the local/remote delta. */
export async function getRecentDriftSubjects(
  repoPath: string,
  localRef: string,
  remoteRef: string,
  limit: number,
  options: LocalGitExecOptions = {}
): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['log', '--format=%s', '-n', String(limit), `${localRef}..${remoteRef}`],
      {
        ...gitExecOptions(repoPath, options),
        timeout: DEFAULT_BASE_REF_PROBE_TIMEOUT_MS
      }
    )
    return stdout.split('\n').filter((subject) => subject.trim().length > 0)
  } catch {
    return []
  }
}

/** Parse `git remote` stdout into a remote count. */
export function parseRemoteCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.trim().length > 0).length
}

/** Count configured remotes; zero means either none or unavailable. */
export async function getRemoteCount(path: string): Promise<number> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: path })
    return parseRemoteCount(stdout)
  } catch (err) {
    console.warn('[getRemoteCount] git remote failed', { path, err })
    return 0
  }
}

/** Resolve the configured push remote without assuming a provider. */
export async function getDefaultRemote(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string> {
  const defaultRef = await getDefaultBaseRefAsync(path, options)
  const defaultBranch = defaultRef
    ? defaultRef.includes('/')
      ? defaultRef.split('/').slice(1).join('/')
      : defaultRef
    : null

  if (defaultBranch) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['config', '--get', `branch.${defaultBranch}.remote`],
        gitExecOptions(path, options)
      )
      const value = stdout.trim()
      if (value) {
        return value
      }
    } catch {
      // Fall through: branch has no explicit remote configured.
    }
  }

  try {
    const { stdout } = await gitExecFileAsync(['remote'], gitExecOptions(path, options))
    const remotes = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (remotes.includes('origin')) {
      return 'origin'
    }
    if (remotes.length === 1) {
      return remotes[0]
    }
    if (remotes.length === 0) {
      throw new Error('Repo has no configured git remotes.')
    }
    throw new Error(
      `Repo has multiple remotes (${remotes.join(', ')}) and no default is configured. Set branch.<default>.remote.`
    )
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error('Failed to resolve default remote for repo.')
  }
}

/** Build a hosted file URL when the origin belongs to a supported provider. */
export function getRemoteFileUrl(
  repoPath: string,
  relativePath: string,
  line: number
): string | null {
  const remoteUrl = getRemoteUrl(repoPath)
  if (!remoteUrl) {
    return null
  }
  const defaultBaseRef = getDefaultBaseRef(repoPath)
  if (!defaultBaseRef) {
    return null
  }
  return buildHostedRemoteFileUrl(
    remoteUrl,
    relativePath,
    defaultBaseRef.replace(/^origin\//, ''),
    line
  )
}

/** Build a hosted commit URL when the origin belongs to a supported provider. */
export function getRemoteCommitUrl(repoPath: string, sha: string): string | null {
  const remoteUrl = getRemoteUrl(repoPath)
  return remoteUrl ? buildHostedRemoteCommitUrl(remoteUrl, sha) : null
}
