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

async function resolveComparisonBase(execGit: GitExec, base: string): Promise<string> {
  const refs = (
    await safeExec(execGit, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/HEAD'))

  if (refs.includes(base)) {
    return base
  }

  const preferredRemoteRefs = [`origin/${base}`, `upstream/${base}`]
  for (const ref of preferredRemoteRefs) {
    if (refs.includes(ref)) {
      return ref
    }
  }

  return refs.find((ref) => ref.endsWith(`/${base}`)) ?? base
}

type PullRequestBranchPreparation = {
  comparisonBase: string
  branchChanged: boolean
}

async function preparePullRequestBranch(
  execGit: GitExec,
  base: string
): Promise<PullRequestBranchPreparation> {
  await requiredExec(
    execGit,
    ['fetch', '--all', '--prune'],
    'Fetch before generating PR details failed'
  )
  const comparisonBase = await resolveComparisonBase(execGit, base)
  const headBeforeRebase = await safeExec(execGit, ['rev-parse', 'HEAD'])
  // Why: GitHub PR diffs are three-dot based; rebasing first keeps already-landed
  // branch changes from bleeding into the generated description.
  await requiredExec(
    execGit,
    ['rebase', comparisonBase],
    'Rebase before generating PR details failed'
  )
  const headAfterRebase = await safeExec(execGit, ['rev-parse', 'HEAD'])
  return {
    comparisonBase,
    branchChanged:
      Boolean(headBeforeRebase) && Boolean(headAfterRebase) && headBeforeRebase !== headAfterRebase
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
