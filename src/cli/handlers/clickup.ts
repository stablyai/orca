import type {
  ClickUpConnectionStatus,
  ClickUpCreateTaskResult,
  ClickUpList,
  ClickUpMutationResult,
  ClickUpTask,
  ClickUpTaskFilter
} from '../../shared/types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { resolveCurrentWorktreeSelector } from '../selectors'
import {
  formatClickUpCreate,
  formatClickUpLists,
  formatClickUpMutation,
  formatClickUpTask,
  formatClickUpTasks,
  formatClickUpWorkspaces
} from '../clickup-format'

const PRIORITIES: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 }
const FILTERS = new Set<ClickUpTaskFilter>(['assigned', 'created', 'all', 'completed', 'open'])

async function resolveTaskTarget({
  flags,
  client,
  cwd
}: Parameters<CommandHandler>[0]): Promise<{ taskId: string; workspaceId?: string }> {
  const input = getOptionalStringFlag(flags, 'id')
  const current = flags.get('current') === true
  if (input && current) {
    throw new RuntimeClientError('invalid_argument', 'Choose a task id or --current, not both.')
  }
  const explicitWorkspaceId = getOptionalStringFlag(flags, 'workspace')
  if (input) {
    return { taskId: input, ...(explicitWorkspaceId ? { workspaceId: explicitWorkspaceId } : {}) }
  }
  if (!current) {
    throw new RuntimeClientError('invalid_argument', 'Pass a ClickUp task id or --current.')
  }
  const envWorktreeId = process.env.ORCA_WORKTREE_ID
  const selector =
    typeof envWorktreeId === 'string' && envWorktreeId.length > 0
      ? `id:${envWorktreeId}`
      : await resolveCurrentWorktreeSelector(cwd, client)
  const response = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  const taskId = response.result.worktree.linkedClickUpTaskId
  if (!taskId) {
    throw new RuntimeClientError(
      'selector_not_found',
      'The current workspace is not linked to a ClickUp task.'
    )
  }
  return {
    taskId,
    workspaceId:
      explicitWorkspaceId ?? response.result.worktree.linkedClickUpWorkspaceId ?? undefined
  }
}

function getFilter(flags: Map<string, string | boolean>): ClickUpTaskFilter | undefined {
  const value = getOptionalStringFlag(flags, 'filter')
  if (!value) {
    return undefined
  }
  if (!FILTERS.has(value as ClickUpTaskFilter)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--filter must be assigned, created, all, completed, or open.'
    )
  }
  return value as ClickUpTaskFilter
}

function getPriority(flags: Map<string, string | boolean>, name: string): number {
  const value = getRequiredStringFlag(flags, name).toLowerCase()
  const priority = PRIORITIES[value]
  if (!priority) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} must be urgent, high, normal, or low.`
    )
  }
  return priority
}

function getDueDate(flags: Map<string, string | boolean>, name: string): string {
  const value = getRequiredStringFlag(flags, name)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new RuntimeClientError('invalid_argument', `--${name} must use YYYY-MM-DD.`)
  }
  return value
}

async function updateTask(
  context: Parameters<CommandHandler>[0],
  updates: Record<string, unknown>
): Promise<void> {
  const target = await resolveTaskTarget(context)
  const response = await context.client.call<ClickUpMutationResult>('clickup.updateTask', {
    ...target,
    updates
  })
  printResult(response, context.json, formatClickUpMutation)
}

export const CLICKUP_HANDLERS: Record<string, CommandHandler> = {
  'clickup task': async (context) => {
    const target = await resolveTaskTarget(context)
    const response = await context.client.call<ClickUpTask | null>('clickup.getTask', target)
    printResult(response, context.json, formatClickUpTask)
  },
  'clickup search': async ({ flags, client, json }) => {
    const response = await client.call<ClickUpTask[]>('clickup.searchTasks', {
      query: getRequiredStringFlag(flags, 'query'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    printResult(response, json, formatClickUpTasks)
  },
  'clickup list': async ({ flags, client, json }) => {
    const response = await client.call<ClickUpTask[]>('clickup.listTasks', {
      filter: getFilter(flags),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    printResult(response, json, formatClickUpTasks)
  },
  'clickup workspace list': async ({ client, json }) => {
    const response = await client.call<ClickUpConnectionStatus>('clickup.status')
    printResult(response, json, formatClickUpWorkspaces)
  },
  'clickup destination list': async ({ flags, client, json }) => {
    const response = await client.call<ClickUpList[]>('clickup.listLists', {
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    printResult(response, json, formatClickUpLists)
  },
  'clickup status set': async (context) =>
    updateTask(context, { status: getRequiredStringFlag(context.flags, 'to') }),
  'clickup priority set': async (context) =>
    updateTask(context, { priority: getPriority(context.flags, 'to') }),
  'clickup priority clear': async (context) => updateTask(context, { priority: null }),
  'clickup due-date set': async (context) =>
    updateTask(context, { dueDate: getDueDate(context.flags, 'to') }),
  'clickup due-date clear': async (context) => updateTask(context, { dueDate: null }),
  'clickup comment add': async (context) => {
    const target = await resolveTaskTarget(context)
    const response = await context.client.call<ClickUpMutationResult>('clickup.addTaskComment', {
      ...target,
      body: getRequiredStringFlag(context.flags, 'body')
    })
    printResult(response, context.json, formatClickUpMutation)
  },
  'clickup create': async ({ flags, client, json }) => {
    const response = await client.call<ClickUpCreateTaskResult>('clickup.createTask', {
      listId: getRequiredStringFlag(flags, 'list'),
      name: getRequiredStringFlag(flags, 'title'),
      description: getOptionalStringFlag(flags, 'body'),
      status: getOptionalStringFlag(flags, 'status'),
      priority: flags.has('priority') ? getPriority(flags, 'priority') : undefined,
      dueDate: flags.has('due-date') ? getDueDate(flags, 'due-date') : undefined,
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    printResult(response, json, formatClickUpCreate)
  }
}
