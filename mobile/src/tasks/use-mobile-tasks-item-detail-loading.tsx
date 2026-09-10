import type { ItemDetailMetadataEffectsModel } from './use-mobile-tasks-item-detail-metadata-effects'
import {
  type HostedReviewDecision,
  buildGitLabCheckSummary,
  useEffect
} from './mobile-tasks-dependencies'
import { type TaskItem, createLinearTask } from './mobile-tasks-legacy-foundation'

export function useMobileTasksItemDetailLoading(model: ItemDetailMetadataEffectsModel) {
  const {
    actionItem,
    detailRefreshSeq,
    setActionItem,
    setDetailError,
    setDetailLoading,
    setDetailPayload,
    setItems,
    taskOperations,
    tasksSupported
  } = model
  useEffect(() => {
    if (!tasksSupported || !actionItem || !taskOperations) {
      setDetailPayload(null)
      setDetailLoading(false)
      setDetailError('')
      return
    }

    let stale = false
    setDetailPayload(null)
    setDetailError('')
    setDetailLoading(true)

    const loadDetails = async (): Promise<void> => {
      if (actionItem.provider === 'github') {
        const details = await taskOperations.detail.loadGitHub({
          repoId: actionItem.source.repoId,
          number: actionItem.source.number,
          type: actionItem.source.type
        })
        if (!stale) {
          setDetailPayload({
            provider: 'github',
            body: details.body,
            comments: details.comments,
            // Why: keep the row's own fields when the host omits them from the detail.
            labels: details.labels ?? actionItem.source.labels,
            assignees: details.assignees,
            reviewDecision: details.reviewDecision ?? actionItem.source.reviewDecision,
            reviewRequests: details.reviewRequests ?? actionItem.source.reviewRequests ?? [],
            latestReviews: details.latestReviews ?? actionItem.source.latestReviews ?? [],
            headSha: details.headSha,
            baseSha: details.baseSha,
            pullRequestId: details.pullRequestId,
            checks: details.checks,
            files: details.files
          })
        }
        return
      }

      if (actionItem.provider === 'gitlab') {
        const details = await taskOperations.detail.loadGitLab({
          repoId: actionItem.source.repoId,
          number: actionItem.source.number,
          type: actionItem.source.type,
          projectRef: actionItem.source.projectRef
        })
        if (!stale) {
          setDetailPayload({
            provider: 'gitlab',
            body: details.body,
            comments: details.comments,
            labels: details.labels ?? actionItem.source.labels,
            assignees: details.assignees,
            pipelineJobs: details.pipelineJobs
          })
          const checksSummary = buildGitLabCheckSummary(details.pipelineJobs ?? [])
          const reviewDecision: Exclude<HostedReviewDecision, null> | undefined =
            details.approvalState?.approvalsRequired && details.approvalState.approvalsLeft === 0
              ? 'approved'
              : details.approvalState?.approvalsLeft && details.approvalState.approvalsLeft > 0
                ? 'review_required'
                : undefined
          const hydratedStatus = {
            ...(details.item?.mergeable !== undefined ? { mergeable: details.item.mergeable } : {}),
            ...(reviewDecision !== undefined ? { reviewDecision } : {}),
            ...(details.reviewers !== undefined ? { reviewerCount: details.reviewers.length } : {})
          }
          setActionItem((current) =>
            current?.provider === 'gitlab' && current.source.id === actionItem.source.id
              ? {
                  ...current,
                  source: {
                    ...current.source,
                    checksSummary,
                    ...hydratedStatus
                  }
                }
              : current
          )
          setItems((current) =>
            current.map((candidate) =>
              candidate.provider === 'gitlab' && candidate.source.id === actionItem.source.id
                ? {
                    ...candidate,
                    source: {
                      ...candidate.source,
                      checksSummary,
                      ...hydratedStatus
                    }
                  }
                : candidate
            )
          )
        }
        return
      }

      const { issue, comments } = await taskOperations.detail.loadLinear({
        issueId: actionItem.source.id,
        workspaceId: actionItem.source.workspaceId
      })
      if (!stale) {
        setDetailPayload({
          provider: 'linear',
          description: issue.description ?? '',
          comments: comments ?? [],
          labels: issue.labels ?? [],
          assignee: issue.assignee?.displayName,
          project: issue.project,
          children: issue.subIssues ?? []
        })
        setActionItem((current) => {
          if (current?.provider !== 'linear' || current.source.id !== issue.id) {
            return current
          }
          const currentChildren = current.source.subIssues ?? []
          const nextChildren = issue.subIssues ?? []
          const alreadyHydrated =
            current.source.project?.id === issue.project?.id &&
            currentChildren.length === nextChildren.length &&
            currentChildren.every((child, index) => child.id === nextChildren[index]?.id)
          return alreadyHydrated
            ? current
            : (createLinearTask(issue) as Extract<TaskItem, { provider: 'linear' }>)
        })
      }
    }

    void loadDetails()
      .catch((err) => {
        if (!stale) {
          setDetailError(err instanceof Error ? err.message : 'Failed to load details')
        }
      })
      .finally(() => {
        if (!stale) {
          setDetailLoading(false)
        }
      })

    return () => {
      stale = true
    }
  }, [actionItem, detailRefreshSeq, taskOperations, tasksSupported])
  return model
}

export type ItemDetailLoadingModel = ReturnType<typeof useMobileTasksItemDetailLoading>
