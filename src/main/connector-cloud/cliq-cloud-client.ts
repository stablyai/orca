// A bot's own Cliq bots and the account's Zoho Cliq sign-ins, as the signed-in account sees them in
// Orca Cloud (cliq-messages.ts in the cloud contract).
import { z } from 'zod'
import {
  BOT_CLIQ_OFF,
  ConnectorBotCliqMembersResponse,
  ConnectorBotCliqStateResponse,
  ConnectorCliqState
} from '../../shared/connector-bot-cliq-contract'
import type { BotSlackResult } from '../../shared/connector-bot-slack-contract'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorCloud } from './connector-cloud'
import { answer } from './connector-cloud-answer'
import type { ConnectorResult } from './connector-cloud-request'

// Creating a Cliq bot makes several Zoho calls in a row.
const APP_SETUP_TIMEOUT_MS = 30_000

/** As for Linear: a bare 404 is a cloud without Cliq. */
export function cliqAnswer<T>(result: ConnectorResult<T>): BotSlackResult<T> {
  return !result.ok && result.status === 404 && result.error === null
    ? { ok: false, error: BOT_CLIQ_OFF }
    : answer(result)
}

const orgQuery = (orgId: string | undefined, separator: '?' | '&'): string =>
  orgId === undefined ? '' : `${separator}org=${encodeURIComponent(orgId)}`

export function cliqCloudClient(cloud: Pick<ConnectorCloud, 'call'>) {
  const botCliq = (botId: string): string =>
    `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/cliq`
  return {
    /** The Cliq organizations the account signed in to, and as whom. */
    cliqState: async () =>
      cliqAnswer(
        await cloud.call(`${CONNECTOR_PATHS.cliq}/state`, undefined, ConnectorCliqState, {
          method: 'GET'
        })
      ),
    /** Forgets the account's sign-in there; its bots stay in Cliq but stop answering. */
    forgetCliqOrg: async (orgId: string) =>
      cliqAnswer(
        await cloud.call(
          `${CONNECTOR_PATHS.cliq}/orgs/${encodeURIComponent(orgId)}`,
          undefined,
          z.undefined(),
          { method: 'DELETE' }
        )
      ),
    /** Creates the bot's Cliq bot in the organization, or repairs an existing one's handlers. */
    setUpCliqBot: async (botId: string, orgId: string) =>
      cliqAnswer(
        await cloud.call(`${botCliq(botId)}/bots`, { v: 1, orgId }, ConnectorBotCliqStateResponse, {
          timeoutMs: APP_SETUP_TIMEOUT_MS
        })
      ),
    /** Without an org, the bot's first; `orgs` lists every one. */
    botCliqState: async (botId: string, orgId?: string) =>
      cliqAnswer(
        await cloud.call(
          `${botCliq(botId)}${orgQuery(orgId, '?')}`,
          undefined,
          ConnectorBotCliqStateResponse,
          { method: 'GET' }
        )
      ),
    /** Deletes the bot's Cliq bot in that organization. */
    removeCliqBot: async (botId: string, orgId: string) =>
      cliqAnswer(
        await cloud.call(`${botCliq(botId)}${orgQuery(orgId, '?')}`, undefined, z.undefined(), {
          method: 'DELETE'
        })
      ),
    cliqMembers: async (botId: string, orgId: string, query: string) =>
      cliqAnswer(
        await cloud.call(
          `${botCliq(botId)}/members?q=${encodeURIComponent(query)}${orgQuery(orgId, '&')}`,
          undefined,
          ConnectorBotCliqMembersResponse,
          { method: 'GET' }
        )
      )
  }
}
