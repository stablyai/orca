import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  LinearAttachRequest,
  LinearAttachResult,
  LinearCommentAddRequest,
  LinearCommentAddResult,
  LinearCreateRequest,
  LinearCreateResult,
  LinearIssueContextResult,
  LinearIssueInclude,
  LinearIssueRequest,
  LinearSearchResult,
  LinearStatusSetRequest,
  LinearStatusSetResult,
  LinearWriteTargetRequest
} from '../../shared/linear-agent-access'
import {
  LINEAR_CHILDREN_MAX_DEPTH,
  LINEAR_WRITE_BODY_CAP,
  clampLinearIssueDepth,
  clampLinearSearchLimit
} from '../../shared/linear-agent-access'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlagAllowingEmpty,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import {
  formatLinearAttach,
  formatLinearCommentAdd,
  formatLinearCreate,
  formatLinearIssue,
  formatLinearSearch,
  formatLinearStatusSet,
  printLinearIssueWarnings,
  printLinearSearchWarnings
} from '../linear-format'

const ISSUE_CONTEXT_TIMEOUT_MS = 120_000
const LINEAR_WRITE_TIMEOUT_MS = 75_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
      teamKey: getOptionalStringFlag(flags, 'team'),
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
    context: buildLinearCurrentContext(cwd, remote)
  }
}

function buildWriteTargetRequest(
  flags: Map<string, string | boolean>,
  cwd: string,
  remote: boolean
): LinearWriteTargetRequest {
  rejectAllWorkspaceForWrite(flags)
  const input = getOptionalStringFlag(flags, 'id')
  const current = flags.get('current') === true
  if (input && current) {
    throw new RuntimeClientError('invalid_argument', 'Pass either <id> or --current, not both')
  }
  if (!input && !current) {
    throw new RuntimeClientError('linear_issue_required', 'Pass a Linear issue id or --current')
  }
  return {
    input,
    current,
    workspaceId: getOptionalStringFlag(flags, 'workspace'),
    context: buildLinearCurrentContext(cwd, remote)
  }
}

function buildLinearCurrentContext(cwd: string, remote: boolean): LinearIssueRequest['context'] {
  return {
    remote,
    ...(remote ? {} : { cwd }),
    ...(process.env.ORCA_WORKTREE_ID ? { worktreeId: process.env.ORCA_WORKTREE_ID } : {}),
    ...(process.env.ORCA_TERMINAL_HANDLE
      ? { terminalHandle: process.env.ORCA_TERMINAL_HANDLE }
      : {})
  }
}

function rejectAllWorkspaceForWrite(flags: Map<string, string | boolean>): void {
  if (getOptionalStringFlag(flags, 'workspace') === 'all') {
    throw new RuntimeClientError(
      'linear_invalid_workspace',
      '--workspace all is not valid for Linear writes'
    )
  }
}

function getOptionalWriteId(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('write-id')) {
    return undefined
  }
  const writeId = getRequiredStringFlag(flags, 'write-id')
  if (!UUID_PATTERN.test(writeId)) {
    throw new RuntimeClientError('linear_invalid_write_id', '--write-id must be a UUID')
  }
  return writeId
}

function getHttpUrlFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = getRequiredStringFlag(flags, name)
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return value
    }
  } catch {
    // Fall through to the stable Linear error below.
  }
  throw new RuntimeClientError('linear_invalid_url', '--url must be an absolute http(s) URL')
}

function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: { required: true }
): Promise<string>
function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: { required: false }
): Promise<string | undefined>
async function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: { required: boolean }
): Promise<string | undefined> {
  const hasBody = flags.has('body')
  const hasBodyFile = flags.has('body-file')
  if (hasBody && hasBodyFile) {
    throw new RuntimeClientError('invalid_argument', 'Use either --body or --body-file, not both')
  }
  if (!hasBody && !hasBodyFile) {
    if (options.required) {
      throw new RuntimeClientError('invalid_argument', 'Missing --body or --body-file')
    }
    return undefined
  }
  const body = hasBody
    ? getRequiredStringFlagAllowingEmpty(flags, 'body')
    : await readLinearBodyFile(getRequiredStringFlag(flags, 'body-file'), cwd)
  if (body.length > LINEAR_WRITE_BODY_CAP) {
    throw new RuntimeClientError(
      'linear_body_too_large',
      `Linear body must be at most ${LINEAR_WRITE_BODY_CAP} characters`
    )
  }
  return body
}

async function readLinearBodyFile(path: string, cwd: string): Promise<string> {
  if (path !== '-') {
    return await readFile(isAbsolute(path) ? path : join(cwd, path), 'utf8')
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin body requested but stdin is a TTY')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}
