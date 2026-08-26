import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import { LINEAR_TEAM_CYCLES_FLAGS } from './ssh-remote-linear-read-flags'

export async function dispatchRemoteLinearTeamCycles(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli
): Promise<RpcResponse> {
  for (const flag of parsed.flags.keys()) {
    if (!LINEAR_TEAM_CYCLES_FLAGS.has(flag)) {
      throw new RemoteCliArgumentError(
        'invalid_argument',
        `Unknown flag --${flag} for command: linear team cycles`
      )
    }
  }
  if (parsed.commandPath.length > 3) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`
    )
  }
  const teamInput = requiredString(parsed.flags, 'team')
  return await dispatcher.dispatch({
    id: `remote-cli-${Date.now()}`,
    authToken: 'remote-cli',
    method: 'linear.agentTeamCycles',
    params: {
      teamInput,
      workspaceId: optionalString(parsed.flags, 'workspace'),
      currentOnly: parsed.flags.get('current') === true
    }
  })
}

function requiredString(flags: Map<string, string | boolean>, name: string): string {
  const value = optionalString(flags, name)
  if (!value) {
    throw new RemoteCliArgumentError('invalid_argument', `Missing --${name}`)
  }
  return value
}

function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
