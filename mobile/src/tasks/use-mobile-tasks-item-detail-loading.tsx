import type { ItemDetailMetadataEffectsModel } from './use-mobile-tasks-item-detail-metadata-effects'
import {
  type HostedReviewDecision,
  buildGitLabCheckSummary,
  useEffect
} from './mobile-tasks-dependencies'
import { type TaskItem, createLinearTask } from './mobile-tasks-model'

export function useMobileTasksItemDetailLoading(model: ItemDetailMetadataEffectsModel) {
  const {
    actionItem,
    detailRefreshSeq,
    setActionItem,
    setDetailError,
    setDetailLoading,
    setDetailPayload,
    setItems,
    taskDetailOperations,
    tasksSupported
  } = model
  useEffect(() => {
    if (!tasksSupported || !actionItem || !taskDetailOperations) {
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
        const details = await taskDetailOperations.loadGitHub({
          repoId: actionItem.source.repoId,
          number: actionItem.source.number,
          type: actionItem.source.type
        })
        if (!stale) {
          setDetailPayload({
            provider: 'github',
            ...details,
            labels: details.labels ?? actionItem.source.labels,
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
        const details = await taskDetailOperations.loadGitLab({
          repoId: actionItem.source.repoId,
          number: actionItem.source.number,
          type: actionItem.source.type,
          projectRef: actionItem.source.projectRef,
          targetId: actionItem.source.targetId
        })
        if (!stale) {
          setDetailPayload({
            provider: 'gitlab',
            ...details,
            labels: details.labels ?? actionItem.source.labels
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

      const { issue, comments } = await taskDetailOperations.loadLinear({
        issueId: actionItem.source.id,
        workspaceId: actionItem.source.workspaceId,
        targetId: actionItem.source.targetId
      })
      if (!stale) {
        setDetailPayload({
          provider: 'linear',
          description: issue.description ?? '',
          comments,
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
  }, [actionItem, detailRefreshSeq, taskDetailOperations, tasksSupported])
  return Object.assign(model, {})
}

export type ItemDetailLoadingModel = ReturnType<typeof useMobileTasksItemDetailLoading>
