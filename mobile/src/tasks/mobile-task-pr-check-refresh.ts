import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import { matchesGitHubWorkItemTarget } from '../../../src/shared/github/work-item-target'
import { acceptPRCheckObservation } from '../../../src/shared/github/complete-pr-check-owner'
import { captureMobilePRCheckContract } from '../transport/pr-check-observation-contract'
import { githubWorkItemBySlugRead } from './mobile-task-source-search-operations'
import { githubTaskKey, sameGitHubTask, requireGitHubTaskTarget } from './github-task-identity'
import { buildGitHubCheckSummary } from './github-check-summary'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import { githubPullRequestChecksRead } from './mobile-task-item-state-operations'
import type { HostedCommentReviewActionsInput } from './use-mobile-tasks-hosted-comment-review-actions'

type RefreshModel = Pick<
  HostedCommentReviewActionsInput,
  | 'client'
  | 'detailPayload'
  | 'tryBeginMutation'
  | 'setError'
  | 'claimPublication'
  | 'setDetailPayload'
  | 'setActionItem'
  | 'setItems'
>

export async function refreshMobileTaskPRChecks(
  model: RefreshModel,
  item: Extract<TaskItem, { provider: 'github' }>
): Promise<void> {
  const {
    client,
    detailPayload,
    tryBeginMutation,
    setError,
    claimPublication,
    setDetailPayload,
    setActionItem,
    setItems
  } = model
  if (!client || item.source.type !== 'pr') {
    return
  }
  const finish = tryBeginMutation()
  if (!finish) {
    return
  }
  setError('')
  const selected = claimPublication(item, detailPayload)
  const requestedHead = detailPayload?.provider === 'github' ? detailPayload.headSha : undefined
  let contract = await captureMobilePRCheckContract(
    client,
    { repo: `id:${item.source.repoId}` },
    true
  )
  const current = () => selected() && contract.current()
  const publish = (owner: GitHubWorkItem | null) => {
    const update = (source: typeof item.source) =>
      acceptPRCheckObservation(
        {
          ...source,
          headSha: owner?.headSha ?? source.headSha,
          checksSummary: owner?.checksSummary
        },
        source,
        { scope: contract.scope!, complete: true, current: current(), trusted: owner !== null }
      ) ?? source
    setActionItem((prior) =>
      sameGitHubTask(prior, item) ? { ...prior, source: update(prior.source) } : prior
    )
    setItems((prior) =>
      prior.map((candidate) =>
        sameGitHubTask(candidate, item)
          ? { ...candidate, source: update(candidate.source) }
          : candidate
      )
    )
    if (owner) {
      setDetailPayload((prior) =>
        prior?.provider === 'github' && prior.targetKey === githubTaskKey(item.source)
          ? {
              ...prior,
              headSha: owner.headSha,
              checks: prior.headSha === owner.headSha ? prior.checks : []
            }
          : prior
      )
    }
  }
  try {
    const repository = requireGitHubTaskTarget(item.source).repository
    const readOwner = async (): Promise<GitHubWorkItem | null> => {
      try {
        const reply = await githubWorkItemBySlugRead.request(
          contract.client ?? client,
          {
            repo: `id:${item.source.repoId}`,
            owner: repository.owner,
            ownerRepo: repository.repo,
            host: repository.host,
            number: item.source.number,
            type: 'pr'
          },
          contract.options
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this existing lookup parser preserves provider fields; exact identity is validated below before acceptance.
        const observed = githubWorkItemBySlugRead.interpret(reply) as GitHubWorkItem | null
        if (
          matchesGitHubWorkItemTarget(observed, {
            repository,
            type: 'pr',
            number: item.source.number
          })
        ) {
          return observed
        }
      } catch {
        /* Rows remain independently useful when the complete owner is unavailable. */
      }
      return null
    }
    let owner: GitHubWorkItem | null = null
    if (contract.complete) {
      owner = await readOwner()
      if (!current()) {
        return
      }
      publish(owner)
    }
    let checks: ReturnType<typeof githubPullRequestChecksRead.interpret> | undefined
    try {
      const reply = await githubPullRequestChecksRead.request(
        contract.client ?? client,
        {
          repo: `id:${item.source.repoId}`,
          prNumber: item.source.number,
          prRepo: repository,
          headSha: owner?.headSha ?? requestedHead,
          noCache: true
        },
        { timeoutMs: 30_000, ...contract.options }
      )
      checks = githubPullRequestChecksRead.interpret(reply)
    } catch (error) {
      if (selected() && contract.routeCurrent()) {
        setError(error instanceof Error ? error.message : 'Failed to refresh checks')
      }
    }
    if (!selected() || !contract.routeCurrent()) {
      return
    }
    if (checks) {
      const returnedChecks = checks
      setDetailPayload((prior) =>
        prior?.provider === 'github' && prior.targetKey === githubTaskKey(item.source)
          ? { ...prior, checks: returnedChecks }
          : prior
      )
    }
    if (!contract.complete && !current() && selected() && contract.routeCurrent()) {
      const previous = contract
      const replacement = await captureMobilePRCheckContract(client, {
        repo: `id:${item.source.repoId}`
      })
      if (!selected() || !previous.routeCurrent() || !replacement.current()) {
        replacement.retire()
        return
      }
      contract = replacement
      previous.retire()
      if (contract.complete) {
        owner = await readOwner()
        if (current()) {
          publish(owner)
        }
      }
    }
    if (checks && !contract.complete && current()) {
      const summary = buildGitHubCheckSummary(checks)
      const update = (source: typeof item.source) => ({
        ...source,
        checksSummary:
          requestedHead !== undefined &&
          source.headSha === requestedHead &&
          source.checksSummary?.state === summary.state
            ? source.checksSummary
            : summary
      })
      setActionItem((prior) =>
        sameGitHubTask(prior, item) ? { ...prior, source: update(prior.source) } : prior
      )
      setItems((prior) =>
        prior.map((candidate) =>
          sameGitHubTask(candidate, item)
            ? { ...candidate, source: update(candidate.source) }
            : candidate
        )
      )
    }
  } catch (error) {
    if (current()) {
      setError(error instanceof Error ? error.message : 'Failed to refresh checks')
    }
  } finally {
    contract.retire()
    finish()
  }
}
