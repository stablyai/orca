import type {
  ConnectorActionArgs,
  ConnectorActionVerb
} from '../../shared/connector-action-contract'
import {
  CONNECTOR_ACTIONS_PATH,
  ConnectorActionResponse
} from '../../shared/connector-action-contract'
import type {
  ConnectorConversation,
  ConnectorTurnFor
} from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorTransport } from './connector-machine'
import { postWithRetries } from './connector-replies'

export type ConnectorActionRequest = {
  botId: string
  verb: ConnectorActionVerb
  ref?: string
  args: ConnectorActionArgs
  // The conversation the calling run answers, when it answers one: the cloud scopes to its workspace.
  conversation?: ConnectorConversation
  // The turn of it the run is in: only that turn acts as whoever started it.
  turnId?: number
  // Whom the run's turn acts for, so the cloud knows whom its Slack posts count as (bot-turn-for.ts).
  turnFor?: ConnectorTurnFor
}

/** One verb as a bot, retried on a busy or unreachable cloud (a set excepted); a post's postId makes its retry find the first. */
export function postConnectorAction(
  transport: ConnectorTransport,
  request: ConnectorActionRequest,
  signal: AbortSignal,
  random: () => number = Math.random
): Promise<ConnectorResult<ConnectorActionResponse>> {
  const call = {
    path: CONNECTOR_ACTIONS_PATH,
    body: { v: 1, ...request },
    schema: ConnectorActionResponse
  }
  // A set whose answer was lost may have changed the issue; sending it again could undo a change made since.
  return request.verb === 'set'
    ? transport.call(call.path, call.body, call.schema, { signal })
    : postWithRetries(transport, call, signal, random)
}
