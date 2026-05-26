import type { PullRequestDraftContext } from '../../shared/pull-request-generation'

const MAX_PULL_REQUEST_CONTEXT_BYTES = 10 * 1024 * 1024

type GitExec = (
  args: string[],
  options?: { maxBuffer?: number }
) => Promise<{ stdout: string; stderr?: string }>

export type PullRequestContextInput = {
  base: string
  currentTitle: string
  currentBody: string
  currentDraft: boolean
}

async function safeExec(execGit: GitExec, args: string[]): Promise<string> {
  try {
    const { stdout } = await execGit(args, { maxBuffer: MAX_PULL_REQUEST_CONTEXT_BYTES })
    return stdout.trim()
  } catch {
    return ''
  }
}

function summarizeGitError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Git command failed.'
  }
  const lines = error.message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? error.message
}

async function requiredExec(execGit: GitExec, args: string[], label: string): Promise<string> {
  try {
    const { stdout } = await execGit(args, { maxBuffer: MAX_PULL_REQUEST_CONTEXT_BYTES })
    return stdout.trim()
  } catch (error) {
    throw new Error(`${label}: ${summarizeGitError(error)}`)
  }
}

type RemoteState = {
  remotes: string[]
  refs: string[]
}

type RemoteBranch = {
  remote: string
  branch: string
  ref: string
}

function splitGitLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function getRemoteState(execGit: GitExec): Promise<RemoteState> {
  const [remoteOutput, refOutput] = await Promise.all([
    safeExec(execGit, ['remote']),
    safeExec(execGit, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
  ])
  return {
    remotes: splitGitLines(remoteOutput),
    refs: splitGitLines(refOutput).filter((line) => !line.endsWith('/HEAD'))
  }
}

function parseRemoteBranch(ref: string, remotes: string[]): RemoteBranch | null {
  const remote = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => ref.startsWith(`${candidate}/`))
  if (!remote) {
    return null
  }
  const branch = ref.slice(remote.length + 1)
  return branch ? { remote, branch, ref } : null
}

function parseRemoteRef(ref: string, remotes: string[]): RemoteBranch | null {
  const parsed = parseRemoteBranch(ref, remotes)
  if (parsed) {
    return parsed
  }
  const slashIndex = ref.indexOf('/')
  if (slashIndex <= 0 || slashIndex === ref.length - 1) {
    return null
  }
  return {
    remote: ref.slice(0, slashIndex),
    branch: ref.slice(slashIndex + 1),
    ref
  }
}

function resolveComparisonBase(
  base: string,
  state: RemoteState
): {
  comparisonBase: string
  fetchTarget: RemoteBranch | null
} {
  const qualifiedBase = parseRemoteBranch(base, state.remotes)
  if (qualifiedBase) {
    return { comparisonBase: qualifiedBase.ref, fetchTarget: qualifiedBase }
  }
  if (state.refs.includes(base)) {
    return { comparisonBase: base, fetchTarget: parseRemoteRef(base, state.remotes) }
  }

  const preferredRemoteRefs = [`origin/${base}`, `upstream/${base}`]
  for (const ref of preferredRemoteRefs) {
    const parsed = parseRemoteRef(ref, state.remotes)
    if (parsed && (state.refs.includes(ref) || state.remotes.includes(parsed.remote))) {
      return { comparisonBase: ref, fetchTarget: parsed }
    }
  }

  const matchingRefs = state.refs.filter((ref) => ref.endsWith(`/${base}`))
  if (matchingRefs.length === 1) {
    const ref = matchingRefs[0]
    return { comparisonBase: ref, fetchTarget: parseRemoteRef(ref, state.remotes) }
  }

  return { comparisonBase: base, fetchTarget: null }
}

async function fetchComparisonBase(execGit: GitExec, target: RemoteBranch | null): Promise<void> {
  if (!target) {
    return
  }
  await requiredExec(
    execGit,
    [
      'fetch',
      '--no-tags',
      target.remote,
      `+refs/heads/${target.branch}:refs/remotes/${target.remote}/${target.branch}`
    ],
    'Fetch before generating PR details failed'
  )
}

type PullRequestBranchPreparation = {
  comparisonBase: string
  branchChanged: boolean
}

async function preparePullRequestBranch(
  execGit: GitExec,
  base: string
): Promise<PullRequestBranchPreparation> {
  const { comparisonBase, fetchTarget } = resolveComparisonBase(base, await getRemoteState(execGit))
  // Why: PR generation only needs the selected base branch. A repo-wide
  // `fetch --all` makes stale contributor fork remotes block unrelated PRs.
  await fetchComparisonBase(execGit, fetchTarget)
  return {
    comparisonBase,
    // Why: Generate must be read-only. Rebasing the live worktree can rewrite
    // files under the running dev app and trigger a full Electron/Vite reload.
    branchChanged: false
  }
}

export async function getPullRequestDraftContext(
  execGit: GitExec,
  input: PullRequestContextInput
): Promise<PullRequestDraftContext | null> {
  const base = input.base.trim()
  if (!base || base.startsWith('-')) {
    return null
  }

  const { comparisonBase, branchChanged } = await preparePullRequestBranch(execGit, base)
  const [branch, mergeBase] = await Promise.all([
    safeExec(execGit, ['branch', '--show-current']),
    safeExec(execGit, ['merge-base', comparisonBase, 'HEAD'])
  ])
  if (!mergeBase) {
    return null
  }

  const range = `${mergeBase}..HEAD`
  const [commitSummary, changeSummary, patch] = await Promise.all([
    safeExec(execGit, ['log', '--pretty=format:- %s', '--max-count=50', range]),
    safeExec(execGit, ['diff', '--name-status', range]),
    safeExec(execGit, ['diff', '--patch', '--minimal', '--no-color', '--no-ext-diff', range])
  ])

  if (!commitSummary && !changeSummary && !patch) {
    return null
  }

  return {
    branch: branch || null,
    base,
    branchChangedByPreparation: branchChanged,
    currentTitle: input.currentTitle,
    currentBody: input.currentBody,
    currentDraft: input.currentDraft,
    commitSummary,
    changeSummary,
    patch
  }
}
