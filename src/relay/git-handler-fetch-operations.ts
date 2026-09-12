import type { RequestContext } from './dispatcher'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import type { GitPushTarget } from '../shared/worktree/types'
import { normalizeGitErrorMessage, isExecKilledError } from '../shared/git-remote-error'
import { syncForkDefaultBranch, validateGitForkSyncExpectedUpstream } from '../shared/git-fork-sync'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../shared/git-fetch-auto-maintenance'
import {
  githubPullRequestHeadLocalRef,
  gitlabMergeRequestHeadLocalRef,
  isSafeReviewHeadFetchRemote,
  isValidReviewHeadNumber,
  reviewHeadRemoteRefComponent,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../shared/review-head-tracking-ref'

export class GitHandlerFetchOperations extends GitHandlerOperationContext {
  async fetch(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    try {
      try {
        if (params.pushTarget !== undefined) {
          assertGitPushTargetShape(params.pushTarget)
          const pushTarget = params.pushTarget as GitPushTarget
          await this.git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
          await this.git(['fetch', '--prune', pushTarget.remoteName], worktreePath)
          return
        }
        await this.git(['fetch', '--prune'], worktreePath)
      } catch (error) {
        // Why: normalize like local gitFetch so SSH users get actionable messages, not raw stderr (may embed credentials).
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async forkSync(params: Record<string, unknown>, context?: RequestContext) {
    return this.runWithGitReadCacheClear(async () => {
      const worktreePath = params.worktreePath as string
      const expectedUpstream = validateGitForkSyncExpectedUpstream(params.expectedUpstream, {
        required: true
      })
      const controller = new AbortController()
      const abortFromContext = () => controller.abort()
      if (context?.signal?.aborted) {
        controller.abort()
      } else {
        context?.signal?.addEventListener('abort', abortFromContext, { once: true })
      }
      const timeout = setTimeout(() => controller.abort(), 60_000)
      try {
        return await syncForkDefaultBranch(
          (args) =>
            this.git(args, worktreePath, {
              nonInteractive: true,
              signal: controller.signal
            }),
          { expectedUpstream }
        )
      } catch (error) {
        throw new Error(normalizeGitErrorMessage(error, 'push'))
      } finally {
        clearTimeout(timeout)
        context?.signal?.removeEventListener('abort', abortFromContext)
      }
    })
  }

  async fetchRemoteTrackingRef(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const remote = params.remote
    const branch = params.branch
    const ref = params.ref
    const skipAutoMaintenance = params.skipAutoMaintenance
    try {
      if (typeof remote !== 'string' || typeof branch !== 'string' || typeof ref !== 'string') {
        throw new Error('Invalid remote-tracking fetch request.')
      }
      if (skipAutoMaintenance !== undefined && typeof skipAutoMaintenance !== 'boolean') {
        throw new Error('Invalid remote-tracking fetch maintenance option.')
      }
      if (remote.startsWith('-') || branch.startsWith('-')) {
        throw new Error('Remote-tracking fetch inputs must not start with "-".')
      }
      if (ref !== `refs/remotes/${remote}/${branch}`) {
        throw new Error('Remote-tracking ref does not match the requested remote and branch.')
      }

      try {
        const { stdout } = await this.git(['remote'], worktreePath)
        const remotes = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        if (!remotes.includes(remote)) {
          throw new Error(`Remote "${remote}" is not configured.`)
        }
        await this.git(['check-ref-format', `refs/heads/${branch}`], worktreePath)
        await this.git(['check-ref-format', ref], worktreePath)
        await this.git(
          [
            ...(skipAutoMaintenance ? GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS : []),
            'fetch',
            '--no-tags',
            remote,
            `+refs/heads/${branch}:${ref}`
          ],
          worktreePath
        )
      } catch (error) {
        // Why: create-worktree needs a write-capable fetch that generic git.exec rejects; narrow RPC keeps the allowlist tight.
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  // Why: the durable review-head ref embeds the remote's identity, and a
  // missing remote must fail with an actionable message, not a raw fetch error.
  private async reviewHeadRemoteComponent(worktreePath: string, remote: string): Promise<string> {
    let remoteUrl: string
    try {
      const { stdout } = await this.git(['remote', 'get-url', remote], worktreePath)
      remoteUrl = stdout.trim()
    } catch {
      remoteUrl = ''
    }
    if (!remoteUrl) {
      throw new Error(`Remote "${remote}" is not configured.`)
    }
    return reviewHeadRemoteRefComponent(remote, remoteUrl)
  }

  async fetchGitLabMergeRequestHead(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const remote = params.remote
    const mrIid = params.mrIid
    try {
      if (typeof remote !== 'string' || !isValidReviewHeadNumber(mrIid)) {
        throw new Error('Invalid GitLab merge request fetch request.')
      }
      const mergeRequestIid = mrIid
      if (!isSafeReviewHeadFetchRemote(remote)) {
        throw new Error('GitLab merge request fetch remote must not start with "-".')
      }

      try {
        const remoteComponent = await this.reviewHeadRemoteComponent(worktreePath, remote)
        // Why: GitLab fork heads need a dedicated write RPC and ref outside refs/heads/*.
        // Return the exact written path so the client does not re-hash a second get-url.
        const localRef = gitlabMergeRequestHeadLocalRef(remoteComponent, mergeRequestIid)
        await this.git(
          [
            'fetch',
            '--no-tags',
            remote,
            `+refs/merge-requests/${mergeRequestIid}/head:${localRef}`
          ],
          worktreePath,
          { timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
        )
        return { localRef }
      } catch (error) {
        // Why: a timeout kill has no git stderr; name it so the client can classify it as transient.
        if (isExecKilledError(error)) {
          throw new Error(
            `Fetching refs/merge-requests/${mergeRequestIid}/head from "${remote}" timed out.`
          )
        }
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async fetchGitHubPullRequestHead(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const remote = params.remote
    const prNumber = params.prNumber
    try {
      if (typeof remote !== 'string' || !isValidReviewHeadNumber(prNumber)) {
        throw new Error('Invalid GitHub pull request fetch request.')
      }
      if (!isSafeReviewHeadFetchRemote(remote)) {
        throw new Error('GitHub pull request fetch remote must not start with "-".')
      }

      try {
        const remoteComponent = await this.reviewHeadRemoteComponent(worktreePath, remote)
        // Why: return the written path so resolve can rev-parse the same ref the host wrote.
        const localRef = githubPullRequestHeadLocalRef(remoteComponent, prNumber)
        await this.git(
          ['fetch', '--no-tags', remote, `+refs/pull/${prNumber}/head:${localRef}`],
          worktreePath,
          { timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
        )
        return { localRef }
      } catch (error) {
        // Why: a timeout kill has no git stderr; name it so the client can classify it as transient.
        if (isExecKilledError(error)) {
          throw new Error(`Fetching refs/pull/${prNumber}/head from "${remote}" timed out.`)
        }
        throw new Error(normalizeGitErrorMessage(error, 'fetch'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }
}
