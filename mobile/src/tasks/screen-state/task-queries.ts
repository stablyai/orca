import { hashKey, type QueryClient } from '@tanstack/react-query'
import type { PersistedTrustedOrcaHooks } from '../../../../src/shared/orca-yaml-hook-types'
import { defineHostQuery, readHostQueryLive } from '../../query/host-query'
import { hostQueryKey, type HostQueryParams } from '../../query/host-query-key'
import { holdsRestoredHostQueryData } from '../../query/host-query-persistence'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { settingsRead } from '../../settings/mobile-settings-read-operations'
import {
  readJiraConnectionProbeReply,
  type MobileJiraConnection
} from '../providers/jira/jira-mobile-connection'
import { jiraConnectionStatusProbe } from '../providers/jira/mobile-jira-operations'
import {
  taskLinearStatusRead,
  taskPreflightRead,
  taskUiStateRead
} from './mobile-task-runtime-operations'
import type { RuntimeTaskSettings, TaskResumeState } from '../mobile-tasks-view-state-types'
import type {
  GitHubIssueSourceError,
  GitHubIssueSourceFallback
} from '../hosted-review/github-work-item-source-errors'
import type { TaskItem } from '../mobile-tasks-project-workspace-types'
import type { GitHubRepoSources } from '../mobile-tasks-provider-detail-types'
import type { ProviderLoadActionsModel } from '../task-list/use-mobile-tasks-provider-load-actions'
import {
  NO_TASK_INPUT as NO_INPUT,
  TASKS_TARGET,
  taskHydrationStorage,
  taskJiraStatusStorage,
  taskListStorage
} from './task-query-storage'

// What the Tasks screen opens on: settings, resume state and provider availability, read in one batch.
export type TaskHydration = {
  settings: RuntimeTaskSettings
  ui: { taskResumeState?: TaskResumeState; trustedOrcaHooks?: PersistedTrustedOrcaHooks } | null
  glabInstalled: boolean
  linearConnected: boolean
}

export const taskHydrationQuery = defineHostQuery<typeof NO_INPUT, TaskHydration>({
  ...taskHydrationStorage,
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
  ...taskJiraStatusStorage,
  fetch: (client) =>
    jiraConnectionStatusProbe
      .request(client)
      .catch(() => null)
      .then(readJiraConnectionProbeReply),
  gcTime: 10 * 60_000,
  retry: false
})

/** The hydration and Jira status last read for the host; `stored` when it is an earlier launch's copy, which only draws the view. */
export function readKeptTaskHydration(
  queryClient: QueryClient,
  hostId: string
): { hydration?: TaskHydration; jira?: MobileJiraConnection; stored: boolean } {
  const hydrationKey = hostQueryKey(hostId, taskHydrationQuery.family, TASKS_TARGET, NO_INPUT)
  return {
    hydration: queryClient.getQueryData(hydrationKey),
    jira: queryClient.getQueryData(
      hostQueryKey(hostId, taskJiraStatusQuery.family, TASKS_TARGET, NO_INPUT)
    ),
    stored: holdsRestoredHostQueryData(queryClient, hashKey(hydrationKey))
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
  ...taskListStorage,
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
