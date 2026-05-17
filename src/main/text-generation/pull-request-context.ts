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

export async function getPullRequestDraftContext(
  execGit: GitExec,
  input: PullRequestContextInput
): Promise<PullRequestDraftContext | null> {
  const base = input.base.trim()
  if (!base || base.startsWith('-')) {
    return null
  }

  const [branch, mergeBase] = await Promise.all([
    safeExec(execGit, ['branch', '--show-current']),
    safeExec(execGit, ['merge-base', base, 'HEAD'])
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
    currentTitle: input.currentTitle,
    currentBody: input.currentBody,
    currentDraft: input.currentDraft,
    commitSummary,
    changeSummary,
    patch
  }
}
