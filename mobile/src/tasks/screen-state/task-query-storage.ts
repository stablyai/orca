import * as z from 'zod'
import {
  hostQueryKey,
  type HostQueryParams,
  type HostQueryTarget
} from '../../query/host-query-key'
import {
  persistedHostQueryKey,
  type PersistedHostFamily,
  type PersistedHostQueryKey
} from '../../query/host-query-persistence'
import type { MobileJiraConnection } from '../providers/jira/jira-mobile-connection'
import type { TaskHydration, TaskListSnapshot } from './task-queries'

// Kept apart from task-queries so the page's first-paint keys don't pull the Tasks reads into boot.

// Tasks reads span the desktop and the servers it relays to; the routed client sends each repo's read to its owner.
export const TASKS_TARGET: HostQueryTarget = { exec: 'local' }
export const NO_TASK_INPUT = {}

const TASK_PROVIDERS = ['github', 'gitlab', 'linear', 'jira'] as const

// Only what draws the screen's view: agent launch settings and hook trust stay off disk, and a
// stored copy is never acted on (the screen waits for a live read before Tasks is ready).
const VIEW_SETTING_KEYS = [
  'defaultTaskSource',
  'defaultTaskViewPreset',
  'visibleTaskProviders',
  'defaultRepoSelection',
  'defaultLinearTeamSelection',
  'githubProjects'
] as const

const storedHydrationSchema = z.object({
  settings: z.looseObject({}),
  ui: z.object({ taskResumeState: z.looseObject({}).optional() }).nullable(),
  glabInstalled: z.boolean(),
  linearConnected: z.boolean()
})

export const taskHydrationStorage: PersistedHostFamily<TaskHydration> = {
  family: 'tasks.hydration',
  persist: {
    version: 1,
    dataSchema: z.custom<TaskHydration>((data) => storedHydrationSchema.safeParse(data).success),
    strip: (hydration) => ({
      settings: Object.fromEntries(
        VIEW_SETTING_KEYS.flatMap((key) =>
          hydration.settings[key] === undefined ? [] : [[key, hydration.settings[key]]]
        )
      ),
      ui: hydration.ui && { taskResumeState: hydration.ui.taskResumeState },
      glabInstalled: hydration.glabInstalled,
      linearConnected: hydration.linearConnected
    })
  }
}

const storedJiraSchema = z.looseObject({
  connected: z.boolean(),
  sites: z.array(z.looseObject({})),
  selection: z.string().nullable()
})

export const taskJiraStatusStorage: PersistedHostFamily<MobileJiraConnection> = {
  family: 'tasks.jiraStatus',
  persist: {
    version: 1,
    dataSchema: z.custom<MobileJiraConnection>((data) => storedJiraSchema.safeParse(data).success)
  }
}

const storedTaskItemSchema = z.looseObject({
  key: z.string(),
  provider: z.enum(['github', 'gitlab', 'gitlabTodo', 'linear', 'jira']),
  title: z.string(),
  subtitle: z.string(),
  status: z.string(),
  updatedAt: z.string(),
  source: z.looseObject({})
})
const storedTaskListSchema = z.object({
  items: z.array(storedTaskItemSchema),
  github: z
    .object({
      sources: z.record(z.string(), z.looseObject({})),
      sourceErrors: z.array(z.unknown()),
      sourceFallbacks: z.array(z.unknown()),
      countedTotalPages: z.number().nullable()
    })
    .optional()
})

export const taskListStorage: PersistedHostFamily<TaskListSnapshot> = {
  family: 'tasks.list',
  persist: {
    version: 1,
    dataSchema: z.custom<TaskListSnapshot>((data) => storedTaskListSchema.safeParse(data).success),
    // A read's warnings describe that read; a later launch shows its rows without them.
    strip: (snapshot) =>
      snapshot.github
        ? {
            items: snapshot.items,
            github: { ...snapshot.github, sourceErrors: [], sourceFallbacks: [] }
          }
        : { items: snapshot.items }
  }
}

/** Per provider, the inputs of the list it showed last, so the next launch knows which stored list to draw. */
export const taskLastListStorage: PersistedHostFamily<HostQueryParams> = {
  family: 'tasks.lastList',
  persist: {
    version: 1,
    dataSchema: z.custom<HostQueryParams>(
      (params) =>
        z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .safeParse(params).success
    )
  }
}

export function taskLastListKey(hostId: string, provider: string) {
  return hostQueryKey(hostId, taskLastListStorage.family, TASKS_TARGET, { provider })
}

export function taskListKey(hostId: string, params: HostQueryParams) {
  return hostQueryKey(hostId, taskListStorage.family, TASKS_TARGET, params)
}

/** What the Tasks screen draws before its first read: the view, Jira's status and which list each provider showed. */
export function firstPaintTaskKeys(hostId: string): PersistedHostQueryKey[] {
  const keys = [
    persistedHostQueryKey(
      taskHydrationStorage,
      hostQueryKey(hostId, taskHydrationStorage.family, TASKS_TARGET, NO_TASK_INPUT)
    ),
    persistedHostQueryKey(
      taskJiraStatusStorage,
      hostQueryKey(hostId, taskJiraStatusStorage.family, TASKS_TARGET, NO_TASK_INPUT)
    ),
    ...TASK_PROVIDERS.map((provider) =>
      persistedHostQueryKey(taskLastListStorage, taskLastListKey(hostId, provider))
    )
  ]
  return keys.filter((key) => key !== null)
}
