import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import { defineHostQuery, readHostQueryLive } from '../query/host-query'
import {
  hostQueryKey,
  type HostQueryKey,
  type HostQueryParams,
  type HostQueryTarget,
  hostScopeKey
} from '../query/host-query-key'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { settingsRead } from '../settings/mobile-settings-read-operations'
import { readJiraConnectionProbeReply, type MobileJiraConnection } from './jira-mobile-connection'
import { jiraConnectionStatusProbe } from './mobile-jira-operations'
import {
  taskLinearStatusRead,
  taskPreflightRead,
  taskUiStateRead
} from './mobile-task-runtime-operations'
import type { RuntimeTaskSettings, TaskResumeState } from './mobile-tasks-view-state-types'
import type {
  GitHubIssueSourceError,
  GitHubIssueSourceFallback
} from './github-work-item-source-errors'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { GitHubRepoSources } from './mobile-tasks-provider-detail-types'
import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'

// Tasks reads span the desktop and the servers it relays to; the routed client sends each repo's read to its owner.
const TASKS_TARGET: HostQueryTarget = { exec: 'local' }
const NO_INPUT = {}

// What the Tasks screen opens on: settings, resume state and provider availability, read in one batch.
export type TaskHydration = {
  settings: RuntimeTaskSettings
  ui: { taskResumeState?: TaskResumeState; trustedOrcaHooks?: PersistedTrustedOrcaHooks } | null
  glabInstalled: boolean
  linearConnected: boolean
}

export const taskHydrationQuery = defineHostQuery<typeof NO_INPUT, TaskHydration>({
  family: 'tasks.hydration',
  // Keep raw Promise.all fail-fast behavior; an all-settled interpretation barrier would wait and could change error precedence.
  fetch: async (client) => {
    const [settingsReply, uiReply, preflightReply, linearReply] = await Promise.all([
      settingsRead.request(client),
      taskUiStateRead.request(client),
      taskPreflightRead.request(client),
      taskLinearStatusRead.request(client)
    ])
    const settings = settingsRead.interpret(settingsReply)
    const ui = taskUiStateRead.interpret(uiReply)
    const preflight = taskPreflightRead.interpret(preflightReply)
    const linear = taskLinearStatusRead.interpret(linearReply)
    return {
      settings: settings.accepted
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          ((settings.value ?? {}) as RuntimeTaskSettings)
        : {},
      ui: ui.accepted
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema checks the `{ ui }` container and leaves both members `unknown`, because each is forwarded whole and re-read field by field with its own defaults downstream.
          ((ui.value as TaskHydration['ui'] | undefined) ?? null)
        : null,
      glabInstalled: preflight.accepted && preflight.value?.glab?.installed === true,
      linearConnected: linear.accepted && linear.value?.connected === true
    }
  },
  gcTime: 10 * 60_000,
  retry: false
})

// Jira is advisory: its own read, so it never holds up the other providers.
export const taskJiraStatusQuery = defineHostQuery<typeof NO_INPUT, MobileJiraConnection>({
  family: 'tasks.jiraStatus',
  fetch: (client) =>
    jiraConnectionStatusProbe
      .request(client)
      .catch(() => null)
      .then(readJiraConnectionProbeReply),
  gcTime: 10 * 60_000,
  retry: false
})

export function readKeptTaskHydration(
  queryClient: QueryClient,
  hostId: string
): { hydration?: TaskHydration; jira?: MobileJiraConnection } {
  return {
    hydration: queryClient.getQueryData(
      hostQueryKey(hostId, taskHydrationQuery.family, TASKS_TARGET, NO_INPUT)
    ),
    jira: queryClient.getQueryData(
      hostQueryKey(hostId, taskJiraStatusQuery.family, TASKS_TARGET, NO_INPUT)
    )
  }
}

export function readTaskHydration(queryClient: QueryClient, hostId: string, client: RpcClient) {
  return readHostQueryLive(
    queryClient,
    taskHydrationQuery,
    { hostId, client },
    TASKS_TARGET,
    NO_INPUT,
    // Each connection reads its own; a read still out belongs to the previous one.
    { replace: true }
  )
}

export function readTaskJiraStatus(queryClient: QueryClient, hostId: string, client: RpcClient) {
  return readHostQueryLive(
    queryClient,
    taskJiraStatusQuery,
    { hostId, client },
    TASKS_TARGET,
    NO_INPUT,
    { replace: true }
  )
}

const hydrationWrites = new WeakMap<QueryClient, Map<string, number>>()

/** Local edits since the screen last read its hydration; a read that overlapped one must not be applied. */
export function taskHydrationWrites(queryClient: QueryClient, hostId: string): number {
  return hydrationWrites.get(queryClient)?.get(hostId) ?? 0
}

/** Keeps the kept hydration in step with this phone's own settings and resume writes, so a revisit opens where it left. */
export function patchTaskHydration(
  queryClient: QueryClient,
  hostId: string,
  patch: (hydration: TaskHydration) => TaskHydration
): void {
  const writes = hydrationWrites.get(queryClient) ?? new Map<string, number>()
  hydrationWrites.set(queryClient, writes)
  writes.set(hostId, (writes.get(hostId) ?? 0) + 1)
  queryClient.setQueryData<TaskHydration>(
    hostQueryKey(hostId, taskHydrationQuery.family, TASKS_TARGET, NO_INPUT),
    (kept) => kept && patch(kept)
  )
}

// The list a filter showed last, so going back to that filter paints it at once.
export type TaskListSnapshot = (
  | { items: TaskItem[]; github?: undefined }
  // First GitHub page's banners and page count, so restored rows page and warn as they did.
  | {
      items: Extract<TaskItem, { provider: 'github' }>[]
      github: {
        sources: Record<string, GitHubRepoSources>
        sourceErrors: GitHubIssueSourceError[]
        sourceFallbacks: GitHubIssueSourceFallback[]
        countedTotalPages: number | null
      }
    }
) & {
  // Some repos failed to read; shown with the rows.
  notice?: string
}

// Read by the Tasks loader with its own inputs (repos, routed client); a superseded read stops at the next repo.
export const taskListQuery = defineHostQuery<HostQueryParams, TaskListSnapshot>({
  family: 'tasks.list',
  gcTime: 10 * 60_000,
  retry: false
})

export function readTaskList(
  queryClient: QueryClient,
  host: { hostId: string; client: RpcClient },
  params: HostQueryParams,
  read: (signal: AbortSignal) => Promise<TaskListSnapshot>
): Promise<TaskListSnapshot> {
  return readHostQueryLive(queryClient, taskListQuery, host, TASKS_TARGET, params, {
    replace: true,
    read
  })
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
>

/**
 * The inputs that pick a list's rows, or null for a list with no read behind it (disconnected, Project mode).
 * `repoKey` is the saved repo filter, not the reconciled one: it is known before the repo list loads.
 */
export function taskListParams(input: TaskListInput, repoKey: string): HostQueryParams | null {
  const { appliedQuery: query, provider } = input
  switch (provider) {
    case 'github':
      return input.githubMode === 'items'
        ? { provider, kind: input.githubKind, query, repos: repoKey }
        : null
    case 'gitlab':
      return { provider, view: input.gitlabView, filter: input.gitlabFilter, query, repos: repoKey }
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
}

export function taskListKey(hostId: string, params: HostQueryParams): HostQueryKey {
  return hostQueryKey(hostId, taskListQuery.family, TASKS_TARGET, params)
}

type TaskListView = Pick<
  ProviderLoadActionsModel,
  | 'hostId'
  | 'items'
  | 'setError'
  | 'setItems'
  | 'setGithubPages'
  | 'setGithubCurrentPage'
  | 'setGithubRepoSources'
  | 'setGithubSourceErrors'
  | 'setGithubSourceFallbacks'
  | 'setGithubCountedTotalPages'
  | 'setLoading'
  | 'setTaskListSettled'
>

/** The lists each filter read last, and which of them a read in flight is standing on. */
export function useTaskListCache(view: TaskListView) {
  const queryClient = useQueryClient()
  const { hostId } = view
  // Set while kept rows stand in for a read in flight; drives the header's refresh line, not the list spinner.
  const [revalidating, setRevalidating] = useState(false)
  // The provider whose rows are on screen, so a provider switch never keeps another provider's rows.
  const shownProviderRef = useRef<string | null>(null)
  const shownRowsRef = useRef(view.items)
  useLayoutEffect(() => {
    shownRowsRef.current = view.items
  }, [view.items])

  // Stops a replaced or abandoned read before its next repo; the kept rows stay as they were.
  const cancelRead = useCallback((): void => {
    void queryClient.cancelQueries(
      { queryKey: [...hostScopeKey(hostId), taskListQuery.family], fetchStatus: 'fetching' },
      { silent: true }
    )
  }, [hostId, queryClient])

  // A read of `key` starts on that filter's kept rows, else on the same provider's rows still shown, else the spinner.
  const begin = useCallback(
    (key: HostQueryKey | null, provider: string): void => {
      cancelRead()
      const kept = key ? queryClient.getQueryData<TaskListSnapshot>(key) : undefined
      if (kept) {
        shownProviderRef.current = provider
        view.setItems(kept.items)
        view.setError(kept.notice ?? '')
        if (kept.github) {
          const { sources } = kept.github
          view.setGithubRepoSources((current) => ({ ...current, ...sources }))
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
    [cancelRead, queryClient]
  )
  const shown = useCallback((provider: string): void => {
    shownProviderRef.current = provider
  }, [])
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
  return { revalidating, setRevalidating, begin, shown, cancelRead, rememberPageCount }
}
