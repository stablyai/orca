import type {
  BotSlackResult,
  ConnectorBotSlackAppResponse
} from '../../shared/connector-bot-slack-contract'

/** Window-only; see main/ipc/slack-hand-off.ts. */
export type SlackHandOffApi = {
  /** Creates the paired computer's bot app the code names, with this desktop's own Orca account. */
  redeem: (args: { code: string }) => Promise<BotSlackResult<ConnectorBotSlackAppResponse>>
}
