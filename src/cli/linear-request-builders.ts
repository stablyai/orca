import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  LinearIssueInclude,
  LinearIssueListRequest,
  LinearIssueRequest,
  LinearIssueTaskUpdateRequest,
  LinearWriteTargetRequest
} from '../shared/linear-agent-access'
import {
  LINEAR_CHILDREN_MAX_DEPTH,
  LINEAR_WRITE_BODY_CAP,
  clampLinearIssueDepth
} from '../shared/linear-agent-access'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from './flags'
import { RuntimeClientError } from './runtime-client'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LINEAR_PRIORITY_VALUES = new Map([
  ['none', 0],
  ['urgent', 1],
  ['high', 2],
  ['medium', 3],
  ['low', 4]
])

export function buildAssigneeSetRequest(
  flags: Map<string, string | boolean>,
  cwd: string,
  remote: boolean
): LinearIssueTaskUpdateRequest {
  const me = flags.get('me') === true
  const toId = getOptionalStringFlag(flags, 'to-id')
  if (me === Boolean(toId)) {
    throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --me or --to-id')
  }
  return {
    ...buildWriteTargetRequest(flags, cwd, remote),
    operation: 'assignee',
    ...(me ? { assigneeMe: true } : { assigneeId: toId })
  }
}

export function getLinearListFilter(
  flags: Map<string, string | boolean>
): LinearIssueListRequest['filter'] {
  const filter = getOptionalStringFlag(flags, 'filter') ?? 'assigned'
  if (['assigned', 'created', 'all', 'completed', 'open'].includes(filter)) {
    return filter as LinearIssueListRequest['filter']
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--filter must be assigned, created, all, completed, or open'
  )
}

export function getPriorityFlag(flags: Map<string, string | boolean>, name: string): number {
  const value = getRequiredStringFlag(flags, name).toLocaleLowerCase()
  const priority = LINEAR_PRIORITY_VALUES.get(value)
  if (priority === undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} must be none, low, medium, high, or urgent`
    )
  }
  return priority
}

export function getRequiredNonNegativeIntegerFlag(
  flags: Map<string, string | boolean>,
  name: string
): number {
  const raw = getRequiredStringFlag(flags, name)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a non-negative integer`)
  }
  return value
}

export function getDueDateFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = getRequiredStringFlag(flags, name)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RuntimeClientError('invalid_argument', `--${name} must use YYYY-MM-DD`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a real calendar date`)
  }
  return value
}

export function getRequiredRepeatedStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string[] {
  const values = getRepeatedStringFlag(flags, name)
  if (values.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return values
}

export function buildIssueRequest(
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

export function buildWriteTargetRequest(
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

export function buildLinearCurrentContext(
  cwd: string,
  remote: boolean
): LinearIssueRequest['context'] {
  return {
    remote,
    ...(remote ? {} : { cwd }),
    ...(process.env.ORCA_WORKTREE_ID ? { worktreeId: process.env.ORCA_WORKTREE_ID } : {}),
    ...(process.env.ORCA_TERMINAL_HANDLE
      ? { terminalHandle: process.env.ORCA_TERMINAL_HANDLE }
      : {})
  }
}

export function rejectAllWorkspaceForWrite(flags: Map<string, string | boolean>): void {
  if (getOptionalStringFlag(flags, 'workspace') === 'all') {
    throw new RuntimeClientError(
      'linear_invalid_workspace',
      '--workspace all is not valid for Linear writes'
    )
  }
}

export function getOptionalWriteId(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('write-id')) {
    return undefined
  }
  const writeId = getRequiredStringFlag(flags, 'write-id')
  if (!UUID_PATTERN.test(writeId)) {
    throw new RuntimeClientError('linear_invalid_write_id', '--write-id must be a UUID')
  }
  return writeId
}

export function getHttpUrlFlag(flags: Map<string, string | boolean>, name: string): string {
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

export function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: { required: true }
): Promise<string>
export function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: { required: false }
): Promise<string | undefined>
export async function readLinearBody(
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
