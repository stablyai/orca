import type {
  LinearAttachRequest,
  LinearAttachResult,
  LinearCommentAddRequest,
  LinearCommentAddResult,
  LinearCreateRequest,
  LinearCreateResult,
  LinearIssueListRequest,
  LinearIssueListResult,
  LinearIssueContextResult,
  LinearProjectListRequest,
  LinearProjectListResult,
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearSearchResult,
  LinearStatusSetRequest,
  LinearStatusSetResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult
} from '../../shared/linear-agent-access'
import { clampLinearSearchLimit } from '../../shared/linear-agent-access'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import {
  buildAssigneeSetRequest,
  buildIssueRequest,
  buildLinearCurrentContext,
  buildWriteTargetRequest,
  getDueDateFlag,
  getHttpUrlFlag,
  getLinearListFilter,
  getOptionalWriteId,
  getPriorityFlag,
  getRequiredNonNegativeIntegerFlag,
  getRequiredRepeatedStringFlag,
  readLinearBody,
  rejectAllWorkspaceForWrite
} from '../linear-request-builders'
import {
  formatLinearAttach,
  formatLinearCommentAdd,
  formatLinearCreate,
  formatLinearIssue,
  formatLinearIssueList,
  formatLinearProjectList,
  formatLinearTaskUpdate,
  formatLinearSearch,
  formatLinearStatusSet,
  formatLinearTeamLabels,
  formatLinearTeamList,
  formatLinearTeamMembers,
  formatLinearTeamStates,
  printLinearIssueWarnings,
  printLinearListWarnings,
  printLinearProjectListWarnings,
  printLinearSearchWarnings
} from '../linear-format'

const ISSUE_CONTEXT_TIMEOUT_MS = 120_000
const LINEAR_WRITE_TIMEOUT_MS = 75_000

export const LINEAR_HANDLERS: Record<string, CommandHandler> = {
  'linear issue': async ({ flags, client, cwd, json }) => {
    const request = buildIssueRequest(flags, cwd, client.isRemote)
    const response = await client.call<LinearIssueContextResult>('linear.issueContext', request, {
      timeoutMs: flags.get('full') === true ? ISSUE_CONTEXT_TIMEOUT_MS : undefined
    })
    if (!json) {
      printLinearIssueWarnings(response.result)
    }
    printResult(response, json, formatLinearIssue)
  },
  'linear search': async ({ flags, client, json }) => {
    const limit = clampLinearSearchLimit(getOptionalPositiveIntegerFlag(flags, 'limit'))
    const response = await client.call<LinearSearchResult>('linear.agentSearchIssues', {
      query: getRequiredStringFlag(flags, 'query'),
      limit,
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    if (!json) {
      printLinearSearchWarnings(response.result)
    }
    printResult(response, json, formatLinearSearch)
  },
  'linear team list': async ({ flags, client, json }) => {
    const response = await client.call<LinearTeamListResult>('linear.agentTeamList', {
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    if (!json) {
      printLinearListWarnings(response.result)
    }
    printResult(response, json, formatLinearTeamList)
  },
  'linear team members': async ({ flags, client, json }) => {
    const response = await client.call<LinearTeamMembersResult>('linear.agentTeamMembers', {
      teamInput: getRequiredStringFlag(flags, 'team'),
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    printResult(response, json, formatLinearTeamMembers)
  },
  'linear team states': async ({ flags, client, json }) => {
    const response = await client.call<LinearTeamStatesResult>('linear.agentTeamStates', {
      teamInput: getRequiredStringFlag(flags, 'team'),
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    printResult(response, json, formatLinearTeamStates)
  },
  'linear team labels': async ({ flags, client, json }) => {
    const response = await client.call<LinearTeamLabelsResult>('linear.agentTeamLabels', {
      teamInput: getRequiredStringFlag(flags, 'team'),
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    })
    printResult(response, json, formatLinearTeamLabels)
  },
  'linear project list': async ({ flags, client, json }) => {
    const limit = clampLinearSearchLimit(getOptionalPositiveIntegerFlag(flags, 'limit'))
    const request: LinearProjectListRequest = {
      query: getOptionalStringFlag(flags, 'query'),
      limit,
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    }
    const response = await client.call<LinearProjectListResult>('linear.agentProjectList', request)
    if (!json) {
      printLinearProjectListWarnings(response.result)
    }
    printResult(response, json, formatLinearProjectList)
  },
  'linear list': async ({ flags, client, json }) => {
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const filter = getLinearListFilter(flags)
    const request: LinearIssueListRequest = {
      filter,
      teamInput: getOptionalStringFlag(flags, 'team'),
      limit,
      workspaceId: getOptionalStringFlag(flags, 'workspace')
    }
    const response = await client.call<LinearIssueListResult>('linear.agentIssueList', request)
    if (!json) {
      printLinearListWarnings(response.result)
    }
    printResult(response, json, formatLinearIssueList)
  },
  'linear status set': async ({ flags, client, cwd, json }) => {
    const request: LinearStatusSetRequest = {
      ...buildWriteTargetRequest(flags, cwd, client.isRemote),
      to: getRequiredStringFlag(flags, 'to')
    }
    const response = await client.call<LinearStatusSetResult>('linear.issueSetState', request, {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    })
    printResult(response, json, formatLinearStatusSet)
  },
  'linear assignee set': async (ctx) =>
    runTaskUpdate(ctx, buildAssigneeSetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote)),
  'linear assignee clear': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'assignee',
      assigneeId: null
    }),
  'linear priority set': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'priority',
      priority: getPriorityFlag(ctx.flags, 'to')
    }),
  'linear priority clear': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'priority',
      priority: 0
    }),
  'linear estimate set': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'estimate',
      estimate: getRequiredNonNegativeIntegerFlag(ctx.flags, 'to')
    }),
  'linear estimate clear': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'estimate',
      estimate: null
    }),
  'linear due-date set': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'dueDate',
      dueDate: getDueDateFlag(ctx.flags, 'to')
    }),
  'linear due-date clear': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'dueDate',
      dueDate: null
    }),
  'linear label add': async (ctx) => runLabelUpdate(ctx, 'add'),
  'linear label remove': async (ctx) => runLabelUpdate(ctx, 'remove'),
  'linear label set': async (ctx) => runLabelUpdate(ctx, 'set'),
  'linear comment add': async ({ flags, client, cwd, json }) => {
    const body = await readLinearBody(flags, cwd, { required: true })
    const request: LinearCommentAddRequest = {
      ...buildWriteTargetRequest(flags, cwd, client.isRemote),
      body,
      replyTo: getOptionalStringFlag(flags, 'reply-to'),
      writeId: getOptionalWriteId(flags)
    }
    const response = await client.call<LinearCommentAddResult>('linear.issueAddComment', request, {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    })
    printResult(response, json, formatLinearCommentAdd)
  },
  'linear attach': async ({ flags, client, cwd, json }) => {
    const request: LinearAttachRequest = {
      ...buildWriteTargetRequest(flags, cwd, client.isRemote),
      url: getHttpUrlFlag(flags, 'url'),
      title: getOptionalStringFlag(flags, 'title'),
      writeId: getOptionalWriteId(flags)
    }
    const response = await client.call<LinearAttachResult>('linear.issueAttachLink', request, {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    })
    printResult(response, json, formatLinearAttach)
  },
  'linear create': async ({ flags, client, cwd, json }) => {
    rejectAllWorkspaceForWrite(flags)
    const parentInput = getOptionalStringFlag(flags, 'parent')
    const parentCurrent = flags.get('parent-current') === true
    if (parentInput && parentCurrent) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use either --parent or --parent-current, not both'
      )
    }
    const body = await readLinearBody(flags, cwd, { required: false })
    const request: LinearCreateRequest = {
      title: getRequiredStringFlag(flags, 'title'),
      ...(body !== undefined ? { body } : {}),
      teamInput: getOptionalStringFlag(flags, 'team'),
      projectInput: getOptionalStringFlag(flags, 'project'),
      state: getOptionalStringFlag(flags, 'state'),
      assignee: getOptionalStringFlag(flags, 'assignee'),
      priority: flags.has('priority') ? getPriorityFlag(flags, 'priority') : undefined,
      estimate: flags.has('estimate')
        ? getRequiredNonNegativeIntegerFlag(flags, 'estimate')
        : undefined,
      dueDate: flags.has('due-date') ? getDueDateFlag(flags, 'due-date') : undefined,
      labels: getRepeatedStringFlag(flags, 'label'),
      parentInput,
      parentCurrent,
      workspaceId: getOptionalStringFlag(flags, 'workspace'),
      writeId: getOptionalWriteId(flags),
      context: buildLinearCurrentContext(cwd, client.isRemote)
    }
    const response = await client.call<LinearCreateResult>('linear.issueCreate', request, {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    })
    printResult(response, json, formatLinearCreate)
  }
}

async function runTaskUpdate(
  { client, json }: Parameters<CommandHandler>[0],
  request: LinearIssueTaskUpdateRequest
): Promise<void> {
  const response = await client.call<LinearIssueTaskUpdateResult>(
    'linear.issueUpdateTask',
    request,
    {
      timeoutMs: LINEAR_WRITE_TIMEOUT_MS
    }
  )
  printResult(response, json, formatLinearTaskUpdate)
}

function runLabelUpdate(
  ctx: Parameters<CommandHandler>[0],
  labelMode: 'add' | 'remove' | 'set'
): Promise<void> {
  return runTaskUpdate(ctx, {
    ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
    operation: 'labels',
    labelMode,
    labels: getRequiredRepeatedStringFlag(ctx.flags, 'label')
  })
}
