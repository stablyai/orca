import type { LinearIssueRelationship } from '../../shared/linear-agent-access'
import type { RpcResponse } from '../runtime/rpc/core'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import {
  RemoteLinearWriteArgumentError,
  buildRemoteTargetRequest,
  call,
  requiredString,
  validateLinearRemoteArgs
} from './ssh-remote-linear-write-support'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

const LINEAR_RELATION_FLAGS = new Set([
  'help',
  'json',
  'pairing-code',
  'environment',
  'workspace',
  'current',
  'id',
  'related',
  'type'
])

export async function dispatchRemoteLinearRelationWrite(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  operation: 'add' | 'remove'
): Promise<RpcResponse> {
  const commandVerb = parsed.commandPath[3] === 'rm' ? 'rm' : operation
  validateLinearRemoteArgs(
    parsed,
    LINEAR_RELATION_FLAGS,
    ['linear', 'relation', commandVerb],
    1,
    'id'
  )
  return await call(dispatcher, 'linear.issueRelationWrite', {
    ...buildRemoteTargetRequest(parsed, env, 3),
    relatedInput: requiredString(parsed.flags, 'related'),
    relationship: parseRelationship(requiredString(parsed.flags, 'type')),
    operation
  })
}

function parseRelationship(value: string): LinearIssueRelationship {
  const relationship = {
    blocks: 'blocks',
    'blocked-by': 'blockedBy',
    related: 'relatedTo',
    'duplicate-of': 'duplicateOf'
  }[value]
  if (!relationship) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      '--type must be blocks, blocked-by, related, or duplicate-of'
    )
  }
  return relationship as LinearIssueRelationship
}
