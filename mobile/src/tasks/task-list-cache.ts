import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { hostQueryKey, type HostQueryKey, type HostQueryParams } from '../query/host-query-key'
import type {
  GitHubIssueSourceError,
  GitHubIssueSourceFallback
} from './github-work-item-source-errors'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'

// The list a filter showed last, kept in the page's query cache so going back to that filter paints it at once.
// Stored, not fetched through TanStack: list reads keep their own generation fences, which stop queued per-repo reads.
export type TaskListSnapshot =
  | { items: TaskItem[]; github?: undefined }
  // First GitHub page's banners and page count, so restored rows page and warn as they did.
  | {
      items: Extract<TaskItem, { provider: 'github' }>[]
      github: {
        sourceErrors: GitHubIssueSourceError[]
        sourceFallbacks: GitHubIssueSourceFallback[]
        countedTotalPages: number | null
      }
    }

type TaskListInput = Pick<
  ProviderLoadActionsModel,
  | 'appliedQuery'
  | 'githubKind'
  | 'githubMode'
  | 'gitlabFilter'
  | 'gitlabView'
  | 'jiraConnection'
  | 'jiraFilter'
  | 'linearConnected'
  | 'linearFilter'
  | 'linearOrderBy'
  | 'provider'
  | 'selectedLinearTeamIds'
  | 'selectedLinearWorkspaceId'
  | 'selectedRepoIds'
>

/** The key of the list these inputs read, or null for one with no read behind it (disconnected, Project mode). */
export function taskListKey(hostId: string | undefined, input: TaskListInput): HostQueryKey | null {
  const { appliedQuery: query, provider } = input
  // The saved repo filter, not the reconciled one: it is known before the repo list loads.
  const repoKey = [...input.selectedRepoIds].sort().join('\n')
  const params = ((): HostQueryParams | null => {
    switch (provider) {
      case 'github':
        return input.githubMode === 'items'
          ? { provider, kind: input.githubKind, query, repos: repoKey }
          : null
      case 'gitlab':
        return {
          provider,
          view: input.gitlabView,
          filter: input.gitlabFilter,
          query,
          repos: repoKey
        }
      case 'jira':
        return input.jiraConnection.connected
          ? {
              provider,
              site: input.jiraConnection.selection ?? null,
              filter: input.jiraFilter,
              query
            }
          : null
      case 'linear':
        return input.linearConnected
          ? {
              provider,
              workspace: input.selectedLinearWorkspaceId,
              teams: [...input.selectedLinearTeamIds].sort().join('\n'),
              filter: input.linearFilter,
              order: input.linearOrderBy,
              query
            }
          : null
    }
  })()
  // Lists span repos on the desktop and its servers; the routed client sends each repo's read to its owner.
  return hostId && params ? hostQueryKey(hostId, 'tasks.list', { exec: 'local' }, params) : null
}

type TaskListView = Pick<
  ProviderLoadActionsModel,
  | 'items'
  | 'setItems'
  | 'setGithubPages'
  | 'setGithubCurrentPage'
  | 'setGithubSourceErrors'
  | 'setGithubSourceFallbacks'
  | 'setGithubCountedTotalPages'
  | 'setLoading'
  | 'setTaskListSettled'
>

/** The lists each filter read last, and which of them a read in flight is standing on. */
export function useTaskListCache(view: TaskListView) {
  const queryClient = useQueryClient()
  // Set while kept rows stand in for a read in flight; drives the header's refresh line, not the list spinner.
  const [revalidating, setRevalidating] = useState(false)
  // The provider whose rows are on screen, so a provider switch never keeps another provider's rows.
  const shownProviderRef = useRef<string | null>(null)
  const shownRowsRef = useRef(view.items)
  useLayoutEffect(() => {
    shownRowsRef.current = view.items
  }, [view.items])

  // A read of `key` starts on that filter's kept rows, else on the same provider's rows still shown, else the spinner.
  const begin = useCallback(
    (key: HostQueryKey | null, provider: string): void => {
      const kept = key ? queryClient.getQueryData<TaskListSnapshot>(key) : undefined
      if (kept) {
        shownProviderRef.current = provider
        view.setItems(kept.items)
        if (kept.github) {
          view.setGithubPages([kept.items])
          view.setGithubCurrentPage(0)
          view.setGithubSourceErrors(kept.github.sourceErrors)
          view.setGithubSourceFallbacks(kept.github.sourceFallbacks)
          view.setGithubCountedTotalPages(kept.github.countedTotalPages)
        }
        view.setTaskListSettled(true)
        setRevalidating(true)
      } else if (shownRowsRef.current.length > 0 && shownProviderRef.current === provider) {
        setRevalidating(true)
      } else {
        view.setLoading(true)
      }
    },
    [queryClient]
  )
  const remember = useCallback(
    (key: HostQueryKey | null, provider: string, snapshot: TaskListSnapshot): void => {
      shownProviderRef.current = provider
      if (key) {
        queryClient.setQueryData<TaskListSnapshot>(key, snapshot)
      }
    },
    [queryClient]
  )
  // The GitHub page count lands after the rows; keep it with them.
  const rememberPageCount = useCallback(
    (key: HostQueryKey | null, countedTotalPages: number): void => {
      if (key) {
        queryClient.setQueryData<TaskListSnapshot>(
          key,
          (snapshot) =>
            snapshot?.github && { ...snapshot, github: { ...snapshot.github, countedTotalPages } }
        )
      }
    },
    [queryClient]
  )
  return { revalidating, setRevalidating, begin, remember, rememberPageCount }
}
