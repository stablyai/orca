import type { LinearSaveIssueRequest } from '../shared/linear-agent-access'
import {
  getOptionalNullableNumberFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag
} from './flags'
import {
  buildLinearCurrentContext,
  getDueDateFlag,
  getOptionalWriteId,
  getPriorityFlag,
  readLinearBody,
  rejectAllWorkspaceForWrite
} from './linear-request-builders'
import { RuntimeClientError } from './runtime-client'

export async function buildSaveIssueRequest(
  flags: Map<string, string | boolean>,
  cwd: string,
  remote: boolean
): Promise<LinearSaveIssueRequest> {
  rejectAllWorkspaceForWrite(flags)
  const input = getOptionalStringFlag(flags, 'id')
  const current = flags.get('current') === true
  if (input && current) {
    throw new RuntimeClientError('invalid_argument', 'Pass either <id> or --current, not both')
  }
  const body = await readLinearBody(flags, cwd, { required: false })
  const description = getOptionalStringFlag(flags, 'description')
  if (body !== undefined && description !== undefined) {
    throw new RuntimeClientError('invalid_argument', 'Use either --description or --body, not both')
  }
  return {
    input,
    current,
    workspaceId: getOptionalStringFlag(flags, 'workspace'),
    context: buildLinearCurrentContext(cwd, remote),
    team: getOptionalStringFlag(flags, 'team'),
    title: getOptionalStringFlag(flags, 'title'),
    description: description ?? body,
    state: getOptionalStringFlag(flags, 'state'),
    assignee: getNullableStringFlag(flags, 'assignee'),
    priority: flags.has('priority') ? getPriorityFlag(flags, 'priority') : undefined,
    estimate: getOptionalNullableNumberFlag(flags, 'estimate'),
    dueDate: flags.has('due-date') ? getNullableDueDateFlag(flags, 'due-date') : undefined,
    labels: flags.has('label') ? getRepeatedStringFlag(flags, 'label') : undefined,
    project: getNullableStringFlag(flags, 'project'),
    parentId: getNullableStringFlag(flags, 'parent-id'),
    writeId: getOptionalWriteId(flags)
  }
}

function getNullableStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | null | undefined {
  const value = getOptionalStringFlag(flags, name)
  return value === 'null' ? null : value
}

function getNullableDueDateFlag(flags: Map<string, string | boolean>, name: string): string | null {
  return getOptionalStringFlag(flags, name) === 'null' ? null : getDueDateFlag(flags, name)
}
