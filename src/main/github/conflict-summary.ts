import type { PRConflictSummary } from '../../shared/types'
import { gitExecFileAsync } from '../git/runner'

type LocalGitExecOptions = {
  wslDistro?: string
}

export async function getPRConflictSummary(
  repoPath: string,
  baseRefName: string,
  baseRefOid: string,
  headRefOid: string,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRConflictSummary | undefined> {
  try {
    // Why: the renderer only needs a read-only merge-conflict snapshot. We
    // derive it from local git state so the PR card can show GitHub-style
    // detail without spending additional gh API calls on every refresh. We use
    // GitHub's head OID directly because the registered repo path may not have
    // a matching local branch name for the PR head. For the base side, prefer a
    // freshly-fetched remote-tracking ref so Orca matches GitHub's portal,
    // which compares against the latest base branch tip rather than the PR's
    // older pinned baseRefOid snapshot.
    const latestBaseOid = await resolveLatestBaseOid(
      repoPath,
      baseRefName,
      baseRefOid,
      localGitOptions
    )
    const mergeBase = await resolveMergeBase(repoPath, headRefOid, latestBaseOid, localGitOptions)
    const [commitsBehind, files] = await Promise.all([
      countCommits(repoPath, `${headRefOid}..${latestBaseOid}`, localGitOptions),
      loadConflictingFiles(repoPath, mergeBase, headRefOid, latestBaseOid, localGitOptions)
    ])

    return {
      baseRef: baseRefName,
      baseCommit: latestBaseOid.slice(0, 7),
      commitsBehind,
      files
    }
  } catch {
    return undefined
  }
}

async function resolveLatestBaseOid(
  repoPath: string,
  baseRefName: string,
  fallbackBaseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string> {
  const remoteName = 'origin'

  try {
    // Why: cap the fetch at 10 s so slow or unreachable remotes don't block
    // the conflict-summary derivation indefinitely.
    await gitExecFileAsync(['fetch', '--quiet', remoteName, baseRefName], {
      cwd: repoPath,
      timeout: 10_000,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
    })
  } catch {
    // Why: fetching the base ref keeps the conflict list aligned with GitHub's
    // live mergeability view, but the card must still render offline. If fetch
    // fails, fall back to the base OID GitHub already gave us.
  }

  for (const ref of [`refs/remotes/${remoteName}/${baseRefName}`, `${remoteName}/${baseRefName}`]) {
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', ref], {
        cwd: repoPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
      })
      const oid = stdout.trim()
      if (oid) {
        return oid
      }
    } catch {
      // Try the next ref form before falling back to GitHub's baseRefOid.
    }
  }

  return fallbackBaseOid
}

async function resolveMergeBase(
  repoPath: string,
  headOid: string,
  baseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['merge-base', headOid, baseOid], {
    cwd: repoPath,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  })
  return stdout.trim()
}

async function countCommits(
  repoPath: string,
  range: string,
  localGitOptions: LocalGitExecOptions
): Promise<number> {
  const { stdout } = await gitExecFileAsync(['rev-list', '--count', range], {
    cwd: repoPath,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  })
  return Number.parseInt(stdout.trim(), 10) || 0
}

async function loadConflictingFiles(
  repoPath: string,
  mergeBase: string,
  headOid: string,
  baseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string[]> {
  const modernArgs = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    '--merge-base',
    mergeBase,
    headOid,
    baseOid
  ]
  const legacyArgs = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    headOid,
    baseOid
  ]

  try {
    const result = await gitExecFileAsync(modernArgs, {
      cwd: repoPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
    })
    return parseMergeTreeNameOnlyOutput(result.stdout)
  } catch (error) {
    // Why: `git merge-tree --write-tree` exits with status 1 when it finds
    // conflicts, but still writes the conflicted file list to stdout. Treat
    // that stdout as the useful result instead of dropping the summary.
    const stdoutFromError = getGitErrorOutput(error, 'stdout')
    if (stdoutFromError) {
      return parseMergeTreeNameOnlyOutput(stdoutFromError)
    }

    if (!isUnsupportedMergeBaseOption(error)) {
      throw error
    }

    try {
      const result = await gitExecFileAsync(legacyArgs, {
        cwd: repoPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
      })
      return parseMergeTreeNameOnlyOutput(result.stdout)
    } catch (fallbackError) {
      const fallbackStdout = getGitErrorOutput(fallbackError, 'stdout')
      if (fallbackStdout) {
        return parseMergeTreeNameOnlyOutput(fallbackStdout)
      }
      throw fallbackError
    }
  }
}

function parseMergeTreeNameOnlyOutput(stdout: string): string[] {
  const entries = stdout.split('\0').filter(Boolean)
  if (entries.length === 0) {
    return []
  }

  const [, ...files] = entries
  return files
}

function getGitErrorOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  const output = (error as Partial<Record<'stdout' | 'stderr', unknown>>)[key]
  return typeof output === 'string' ? output : ''
}

function isUnsupportedMergeBaseOption(error: unknown): boolean {
  const output = `${getGitErrorOutput(error, 'stderr')}\n${
    error instanceof Error ? error.message : ''
  }`
  return /(?:unknown|unrecognized) option(?::|\s+)[`']?(?:--?)?merge-base[`']?(?:\s|$)/i.test(
    output
  )
}
