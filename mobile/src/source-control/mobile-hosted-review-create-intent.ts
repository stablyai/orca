import type { RpcClient } from '../transport/rpc-client'
import { requestMobileCommitMessage } from './mobile-commit-message-ai'
import { getStageablePaths, type MobileGitStatusResult } from './mobile-git-status'
import { getMobilePrEligibilityReadiness } from './mobile-open-pr-prefill'
import { resolveMobilePrPrefill, type MobilePrPrefill } from './mobile-pr-create'
import {
  commitMobileHostedReviewStagedChanges,
  mobileHostedReviewBranchStillMatches,
  readMobileHostedReviewGitStatus,
  sendMobileHostedReviewGitMutation
} from './mobile-hosted-review-git-preparation'
import { applyMobileHostedReviewRemotePrerequisite } from './mobile-hosted-review-remote-prerequisite'

export type MobileHostedReviewCreateIntentProgress =
  | 'staging'
  | 'generating_commit_message'
  | 'committing'
  | 'publishing'
  | 'pushing'
  | 'force_pushing'
  | 'creating_review'

type MobileHostedReviewCreateIntentFailure = {
  ok: false
  error: string
  committed?: boolean
  status?: MobileGitStatusResult | null
  commitMessage?: string
}

export type MobileHostedReviewCreateIntentOutcome =
  | {
      ok: true
      prefill: MobilePrPrefill
      status: MobileGitStatusResult | null
      committed: boolean
    }
  | MobileHostedReviewCreateIntentFailure

type PrepareInput = {
  branch: string
  title: string
  status: MobileGitStatusResult | null
  commitMessage?: string
  onProgress?: (progress: MobileHostedReviewCreateIntentProgress) => void
}

export function mobileHostedReviewCreateIntentProgressMessage(
  progress: MobileHostedReviewCreateIntentProgress
): string {
  switch (progress) {
    case 'staging':
      return 'Staging changes...'
    case 'generating_commit_message':
      return 'Generating commit message...'
    case 'committing':
      return 'Committing changes...'
    case 'publishing':
      return 'Publishing branch...'
    case 'pushing':
      return 'Pushing commits...'
    case 'force_pushing':
      return 'Force pushing with lease...'
    case 'creating_review':
      return 'Creating review...'
  }
}

function hasUnresolvedConflicts(status: MobileGitStatusResult | null): boolean {
  return status?.entries.some((entry) => entry.conflictStatus === 'unresolved') === true
}

async function resolvePrefillFromStatus(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  branch: string,
  title: string,
  status: MobileGitStatusResult | null
): Promise<MobilePrPrefill> {
  return resolveMobilePrPrefill(client, worktreeId, {
    branch,
    title,
    ...getMobilePrEligibilityReadiness(status)
  })
}

async function ensureLocalChangesCommitted(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: PrepareInput,
  currentStatus: MobileGitStatusResult | null
): Promise<
  | { ok: true; status: MobileGitStatusResult | null; committed: boolean }
  | MobileHostedReviewCreateIntentFailure
> {
  if ((currentStatus?.entries.length ?? 0) === 0) {
    return { ok: true, status: currentStatus, committed: false }
  }
  if (hasUnresolvedConflicts(currentStatus)) {
    return {
      ok: false,
      error: 'Resolve conflicts before creating a pull request.',
      committed: false,
      status: currentStatus
    }
  }

  const stagePaths = getStageablePaths(currentStatus?.entries ?? [])
  if (stagePaths.length > 0) {
    input.onProgress?.('staging')
    const staged = await sendMobileHostedReviewGitMutation(
      client,
      'git.bulkStage',
      { worktree: `id:${worktreeId}`, filePaths: stagePaths },
      'Failed to stage changes'
    )
    if (!staged.ok) {
      return staged
    }
    const stagedStatus = await readMobileHostedReviewGitStatus(client, worktreeId)
    if (!stagedStatus.ok) {
      return {
        ok: false,
        error: stagedStatus.error,
        committed: false,
        status: currentStatus
      }
    }
    currentStatus = stagedStatus.status
    if (!mobileHostedReviewBranchStillMatches(input.branch, currentStatus)) {
      return {
        ok: false,
        error: 'Branch changed while preparing the pull request.',
        committed: false,
        status: currentStatus
      }
    }
  }

  const hasStagedChanges = currentStatus?.entries.some((entry) => entry.area === 'staged') === true
  if (!hasStagedChanges) {
    return {
      ok: false,
      error: 'Resolve or stage changes before creating a pull request.',
      committed: false,
      status: currentStatus
    }
  }

  let message = input.commitMessage?.trim() ?? ''
  if (!message) {
    input.onProgress?.('generating_commit_message')
    const generated = await requestMobileCommitMessage(client, worktreeId)
    if (!generated.success) {
      return {
        ok: false,
        error: 'Could not generate a commit message. Add one in Source Control, then retry.',
        committed: false,
        status: currentStatus
      }
    }
    message = generated.message
  }

  input.onProgress?.('committing')
  const committed = await commitMobileHostedReviewStagedChanges(client, worktreeId, message)
  if (!committed.ok) {
    return { ...committed, committed: false, status: currentStatus, commitMessage: message }
  }
  const committedStatus = await readMobileHostedReviewGitStatus(client, worktreeId)
  if (!committedStatus.ok) {
    return {
      ok: false,
      error: committedStatus.error,
      committed: true,
      status: currentStatus
    }
  }
  currentStatus = committedStatus.status
  if (!mobileHostedReviewBranchStillMatches(input.branch, currentStatus)) {
    return {
      ok: false,
      error: 'Branch changed while preparing the pull request.',
      committed: true,
      status: currentStatus
    }
  }
  return { ok: true, status: currentStatus, committed: true }
}

export async function prepareMobileHostedReviewCreateIntent(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  input: PrepareInput
): Promise<MobileHostedReviewCreateIntentOutcome> {
  const initialStatus = await readMobileHostedReviewGitStatus(client, worktreeId)
  let currentStatus = initialStatus.ok ? initialStatus.status : input.status
  if (!mobileHostedReviewBranchStillMatches(input.branch, currentStatus)) {
    return {
      ok: false,
      error: initialStatus.ok
        ? 'Branch changed while preparing the pull request.'
        : initialStatus.error,
      status: currentStatus
    }
  }

  const committed = await ensureLocalChangesCommitted(client, worktreeId, input, currentStatus)
  if (!committed.ok) {
    return committed
  }
  currentStatus = committed.status

  let prefill = await resolvePrefillFromStatus(
    client,
    worktreeId,
    input.branch,
    input.title,
    currentStatus
  )
  for (let attempts = 0; attempts < 2; attempts++) {
    const remote = await applyMobileHostedReviewRemotePrerequisite(client, worktreeId, prefill, {
      ...input,
      status: currentStatus
    })
    if (!remote.ok) {
      return { ...remote, committed: committed.committed, status: currentStatus }
    }
    if (!remote.ran) {
      break
    }
    const refreshedStatus = await readMobileHostedReviewGitStatus(client, worktreeId)
    if (!refreshedStatus.ok) {
      return {
        ok: false,
        error: refreshedStatus.error,
        committed: committed.committed,
        status: currentStatus
      }
    }
    currentStatus = refreshedStatus.status
    if (!mobileHostedReviewBranchStillMatches(input.branch, currentStatus)) {
      return {
        ok: false,
        error: 'Branch changed while preparing the pull request.',
        committed: committed.committed,
        status: currentStatus
      }
    }
    prefill = await resolvePrefillFromStatus(
      client,
      worktreeId,
      input.branch,
      input.title,
      currentStatus
    )
  }

  return { ok: true, prefill, status: currentStatus, committed: committed.committed }
}
