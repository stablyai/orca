// Who can ask on each connector: the owner's Linear and GitHub links, and the people each service finds.
// All on the phone's bot allowlist; the host answers each as BotSlackResult.
import * as z from 'zod'
import {
  ConnectorGitHubState,
  ConnectorGitHubUsersResponse
} from '../../../../src/shared/connector-bot-github-contract'
import {
  ConnectorLinearMembersResponse,
  ConnectorLinearState
} from '../../../../src/shared/connector-bot-linear-contract'
import { ConnectorBotSlackMembersResponse } from '../../../../src/shared/connector-bot-slack-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

function connectorRead<
  Method extends
    | 'bots.linear.state'
    | 'bots.github.state'
    | 'bots.slack.members'
    | 'bots.linear.members'
    | 'bots.github.users',
  Value extends z.ZodType
>(method: Method, value: Value) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name: method,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcResultVariant(
        method,
        z.union([
          z.looseObject({ ok: z.literal(true), value }),
          z.looseObject({ ok: z.literal(false), error: z.string() })
        ])
      )
    })
  )
}

export const linearStateRead = connectorRead('bots.linear.state', ConnectorLinearState)
export const gitHubStateRead = connectorRead('bots.github.state', ConnectorGitHubState)
export const slackMembersRead = connectorRead(
  'bots.slack.members',
  ConnectorBotSlackMembersResponse
)
export const linearMembersRead = connectorRead(
  'bots.linear.members',
  ConnectorLinearMembersResponse
)
export const gitHubUsersRead = connectorRead('bots.github.users', ConnectorGitHubUsersResponse)
