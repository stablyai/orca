// Window-only: this desktop's own Orca account creates a paired computer's bot app with its Slack
// grant, from a click in this app's window. No runtime RPC reaches this, so no paired client can.
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { withBotsCloudClient } from '../connector-cloud/bots-cloud-client'
import type {
  BotSlackResult,
  ConnectorBotSlackAppResponse
} from '../../shared/connector-bot-slack-contract'

// The cloud's own bound on a code.
const RedeemArgs = z.object({ code: z.string().min(1).max(128) })

export function registerSlackHandOffHandlers(cloud: () => ConnectorCloud | null): void {
  ipcMain.removeHandler('slackHandOff:redeem')
  ipcMain.handle(
    'slackHandOff:redeem',
    (_event, raw: unknown): Promise<BotSlackResult<ConnectorBotSlackAppResponse>> => {
      const { code } = RedeemArgs.parse(raw)
      return withBotsCloudClient(cloud(), (client) => client.redeemSlackHandOff(code))
    }
  )
}
