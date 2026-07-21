import type {
  LinearIssueRelationship,
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult
} from '../../shared/linear-agent-access'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { formatLinearRelationWrite } from '../linear-format'
import { buildWriteTargetRequest } from '../linear-request-builders'
import { RuntimeClientError } from '../runtime-client'

const LINEAR_WRITE_TIMEOUT_MS = 75_000

export function linearRelationWriteHandler(operation: 'add' | 'remove'): CommandHandler {
  return async ({ flags, client, cwd, json }) => {
    const request: LinearIssueRelationWriteRequest = {
      ...buildWriteTargetRequest(flags, cwd, client.isRemote),
      relatedInput: getRequiredStringFlag(flags, 'related'),
      relationship: parseRelationship(getRequiredStringFlag(flags, 'type')),
      operation
    }
    const response = await client.call<LinearIssueRelationWriteResult>(
      'linear.issueRelationWrite',
      request,
      { timeoutMs: LINEAR_WRITE_TIMEOUT_MS }
    )
    printResult(response, json, formatLinearRelationWrite)
  }
}

function parseRelationship(value: string): LinearIssueRelationship {
  const relationship = {
    blocks: 'blocks',
    'blocked-by': 'blockedBy',
    related: 'relatedTo',
    'duplicate-of': 'duplicateOf'
  }[value]
  if (!relationship) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--type must be blocks, blocked-by, related, or duplicate-of'
    )
  }
  return relationship as LinearIssueRelationship
}
