import type {
  LinearIssueContextResult,
  LinearIssueInclude,
  LinearIssueRequest,
  LinearSearchResult
} from '../../shared/linear-agent-access'
import {
  LINEAR_CHILDREN_MAX_DEPTH,
  clampLinearIssueDepth,
  clampLinearSearchLimit
} from '../../shared/linear-agent-access'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import {
  formatLinearIssue,
  formatLinearSearch,
  printLinearIssueWarnings,
  printLinearSearchWarnings
} from '../linear-format'

const ISSUE_CONTEXT_TIMEOUT_MS = 120_000

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
  }
}

function buildIssueRequest(
  flags: Map<string, string | boolean>,
  cwd: string,
  remote: boolean
): LinearIssueRequest {
  const full = flags.get('full') === true
  const includes: Record<LinearIssueInclude, boolean> = {
    comments: full || flags.get('comments') === true,
    children: full || flags.get('children') === true,
    attachments: full || flags.get('attachments') === true,
    relations: full || flags.get('relations') === true
  }
  if (flags.has('depth') && !includes.children) {
    throw new RuntimeClientError('invalid_argument', '--depth requires --children or --full')
  }
  const requestedDepth = getOptionalNonNegativeIntegerFlag(flags, 'depth')
  if (requestedDepth !== undefined && requestedDepth > LINEAR_CHILDREN_MAX_DEPTH) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--depth must be at most ${LINEAR_CHILDREN_MAX_DEPTH}`
    )
  }
  const workspaceId = getOptionalStringFlag(flags, 'workspace')
  if (workspaceId === 'all') {
    throw new RuntimeClientError(
      'linear_invalid_workspace',
      '--workspace all is not valid for issue'
    )
  }
  const input = getOptionalStringFlag(flags, 'id')
  return {
    input,
    current: input ? false : flags.get('current') === true,
    workspaceId,
    include: includes,
    depth: clampLinearIssueDepth(requestedDepth),
    context: {
      remote,
      ...(remote ? {} : { cwd }),
      ...(process.env.ORCA_WORKTREE_ID ? { worktreeId: process.env.ORCA_WORKTREE_ID } : {}),
      ...(process.env.ORCA_TERMINAL_HANDLE
        ? { terminalHandle: process.env.ORCA_TERMINAL_HANDLE }
        : {})
    }
  }
}
