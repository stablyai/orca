import type {
  ClickUpComment,
  ClickUpConnectionStatus,
  ClickUpTask,
  ClickUpTaskListFilter,
  ClickUpTaskPage
} from '../../shared/clickup/clickup-types'
import {
  CLICKUP_PAGE_RANGE_MESSAGE,
  isClickUpPageIndex
} from '../../shared/clickup/clickup-task-filter'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  formatClickUpStatus,
  formatClickUpTaskContext,
  formatClickUpTaskList,
  formatClickUpTaskPage
} from './clickup-format'
import { requireClickUpConnection, requireClickUpTaskInput } from './clickup-target'
import { CLICKUP_WRITE_HANDLERS } from './clickup-write'

function listFilter(context: HandlerContext, scope: 'assigned' | 'all'): ClickUpTaskListFilter {
  const statuses = getRepeatedStringFlag(context.flags, 'status')
  return {
    scope,
    includeClosed: context.flags.has('include-closed'),
    ...(statuses.length > 0 ? { statuses } : {})
  }
}

export const CLICKUP_HANDLERS: Record<string, CommandHandler> = {
  ...CLICKUP_WRITE_HANDLERS,
  'clickup status': async (context) => {
    const response = await context.client.call<ClickUpConnectionStatus>('clickup.status')
    printResult(response, context.json, formatClickUpStatus)
  },
  'clickup task': async (context) => {
    const input = requireClickUpTaskInput(context)
    await requireClickUpConnection(context)
    const response = await context.client.call<ClickUpTask | null>('clickup.getTask', {
      id: input
    })
    const task = response.result
    if (!task) {
      throw new RuntimeClientError(
        'clickup_task_unavailable',
        'ClickUp did not return the requested task in the selected Workspace.'
      )
    }
    const { result: comments } = await context.client.call<ClickUpComment[]>(
      'clickup.taskComments',
      { id: task.id }
    )
    printResult({ ...response, result: { task, comments } }, context.json, formatClickUpTaskContext)
  },
  'clickup list': async (context) => {
    const filter = listFilter(context, context.flags.has('all') ? 'all' : 'assigned')
    const page = getOptionalNonNegativeIntegerFlag(context.flags, 'page')
    if (page !== undefined && !isClickUpPageIndex(page)) {
      throw new RuntimeClientError('invalid_argument', `--page: ${CLICKUP_PAGE_RANGE_MESSAGE}`)
    }
    await requireClickUpConnection(context)
    const response = await context.client.call<ClickUpTaskPage>('clickup.listTasks', {
      filter,
      page
    })
    printResult(response, context.json, formatClickUpTaskPage)
  },
  'clickup search': async (context) => {
    const query = getRequiredStringFlag(context.flags, 'query').trim()
    if (!query) {
      throw new RuntimeClientError('invalid_argument', 'Search query cannot be blank.')
    }
    await requireClickUpConnection(context)
    const response = await context.client.call<ClickUpTask[]>('clickup.searchTasks', {
      query,
      filter: listFilter(context, 'all')
    })
    printResult(response, context.json, formatClickUpTaskList)
  }
}
