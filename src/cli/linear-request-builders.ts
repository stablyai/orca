import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  LinearIssueInclude,
  LinearIssueListRequest,
  LinearIssueRequest,
  LinearIssueTaskUpdateRequest,
  LinearWriteTargetRequest
} from '../shared/linear/agent-access'
import {
  LINEAR_CHILDREN_MAX_DEPTH,
  LINEAR_WRITE_BODY_CAP,
  clampLinearIssueDepth
} from '../shared/linear/agent-access'
import { isLinearUuid } from '../shared/linear/uuid'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from './flags'
import { RuntimeClientError } from './runtime-client'

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
    relations: full || flags.get('relations') === true,
    activity: full || flags.get('activity') === true
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
  if (!isLinearUuid(writeId)) {
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

type ReadLinearBodyOptions = {
  required: boolean
  // Why: the cap is defined over the normalized text, so normalization has to
  // run before the length check rather than after the value is returned.
  normalize?: (value: string) => string
  // Why: project prose reuses this reader through synthesized flags, so errors
  // have to name the flag the caller actually typed.
  labels?: { value: string; file: string; noun: string }
}

const DEFAULT_BODY_LABELS = { value: 'body', file: 'body-file', noun: 'body' }

export function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: ReadLinearBodyOptions & { required: true }
): Promise<string>
export function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: ReadLinearBodyOptions & { required: false }
): Promise<string | undefined>
export async function readLinearBody(
  flags: Map<string, string | boolean>,
  cwd: string,
  options: ReadLinearBodyOptions
): Promise<string | undefined> {
  const labels = options.labels ?? DEFAULT_BODY_LABELS
  const hasBody = flags.has('body')
  const hasBodyFile = flags.has('body-file')
  if (hasBody && hasBodyFile) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Use either --${labels.value} or --${labels.file}, not both`
    )
  }
  if (!hasBody && !hasBodyFile) {
    if (options.required) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Missing --${labels.value} or --${labels.file}`
      )
    }
    return undefined
  }
  const raw = hasBody
    ? getRequiredStringFlagAllowingEmpty(flags, 'body')
    : await readLinearBodyFile(getRequiredStringFlag(flags, 'body-file'), cwd, labels)
  const body = options.normalize ? options.normalize(raw) : raw
  if (body.length > LINEAR_WRITE_BODY_CAP) {
    throw new RuntimeClientError(
      'linear_body_too_large',
      `Linear ${labels.noun} must be at most ${LINEAR_WRITE_BODY_CAP} characters`
    )
  }
  return body
}

async function readLinearBodyFile(
  path: string,
  cwd: string,
  labels: { value: string; file: string; noun: string }
): Promise<string> {
  if (path !== '-') {
    // Why: over SSH, orca runs on the desktop host with ORCA_CLI_SSH_REMOTE set —
    // a file path here would read the host's disk, not the remote's. (The WSL
    // bridge sets the shared ORCA_CLI_CWD too, but its UNC cwd stays host-readable,
    // so it must not trip this SSH-only guard.)
    if (process.env.ORCA_CLI_SSH_REMOTE === '1') {
      throw new RuntimeClientError(
        'invalid_environment',
        `A --${labels.file} path reads from the machine running orca, not this SSH remote. Pipe the file over stdin and pass - instead.`
      )
    }
    const content = await readFile(isAbsolute(path) ? path : join(cwd, path), 'utf8')
    return rejectBlankLinearBodyFile(stripBom(content), `--${labels.file} ${path}`, labels.noun)
  }
  if (process.stdin.isTTY) {
    throw new RuntimeClientError(
      'invalid_argument',
      `stdin ${labels.noun} requested but stdin is a TTY`
    )
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  const content = Buffer.concat(chunks).toString('utf8')
  return rejectBlankLinearBodyFile(stripBom(content), 'stdin', labels.noun)
}

/**
 * Why: PowerShell and Notepad write UTF-8 with a BOM, and a leading U+FEFF would travel
 * into the body — poisoning the digest and making a re-send read as a change.
 */
function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

// Why: a body sourced from a file or pipe is almost never meant to be blank — an
// empty/whitespace-only source is nearly always an accident (empty variable,
// generator that produced nothing, forgotten pipe), unlike an inline --body/--content
// value, which can deliberately be empty text.
function rejectBlankLinearBodyFile(content: string, source: string, noun: string): string {
  if (content.trim() === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      `${source} was empty or blank; refusing to write an empty ${noun}`
    )
  }
  return content
}
