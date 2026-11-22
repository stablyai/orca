// A bot's Slack app, the account's Slack config grants and its Linear and GitHub links, as the
// signed-in account sees them in Orca Cloud.
import { z } from 'zod'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  ConnectorBotSlackAppResponse,
  ConnectorBotSlackHandOffResponse,
  ConnectorBotSlackMembersResponse,
  ConnectorBotSlackPostAsResponse,
  ConnectorBotSlackStateResponse,
  ConnectorSlackGrantResponse,
  type BotSlackResult,
  type ConnectorBotAvatarRequest,
  type ConnectorBotSlackPostAsRequest,
  type ConnectorBotSlackThreadLinkRequest
} from '../../shared/connector-bot-slack-contract'
import {
  BOT_LINEAR_OFF,
  ConnectorLinearMembersResponse,
  ConnectorLinearState
} from '../../shared/connector-bot-linear-contract'
import {
  BOT_GITHUB_OFF,
  ConnectorGitHubState,
  ConnectorGitHubUsersResponse
} from '../../shared/connector-bot-github-contract'
import {
  ConnectorAccessRequest,
  ConnectorAccessRequestList,
  type BotAccessDecision
} from '../../shared/connector-bot-access-contract'
import {
  CONNECTOR_PATHS,
  type ConnectorConnectSource
} from '../../shared/connectors/connector-cloud-contract'
import {
  ConnectorConnectRedeemRequestSchema,
  ConnectorConnectRedeemSchema,
  ConnectorConnectStartRequestSchema,
  ConnectorConnectStartSchema
} from '../../../cloud/packages/connector-contract/src/connect-messages'
import type { ConnectorCloud } from './connector-cloud'
import type { ConnectorResult } from './connector-cloud-request'

// Creating an app makes several Slack calls in a row.
const APP_SETUP_TIMEOUT_MS = 30_000

// POST {v:1, code}: a code from POST `${bots}/<id>/slack/handoffs` spends the caller's own grant.
const SLACK_HAND_OFF_REDEEM = '/v1/connector/slack/handoffs/redeem'

// A Slack call's workspace; an older cloud ignores it and means its only one.
const teamQuery = (teamId: string | undefined, separator: '?' | '&'): string =>
  teamId === undefined ? '' : `${separator}team=${encodeURIComponent(teamId)}`

function answer<T>(result: ConnectorResult<T>): BotSlackResult<T> {
  if (result.ok) {
    return result
  }
  const error =
    result.error ??
    (result.status === null
      ? BOT_SLACK_DESKTOP_ERRORS.unreachable
      : BOT_SLACK_DESKTOP_ERRORS.failed)
  return { ok: false, error }
}

/** A cloud with Linear off has no Linear routes, so a bare 404 reads as "Coming soon"; a 404 with a code (not_linked, unknown_issue…) is that code. */
function linearAnswer<T>(result: ConnectorResult<T>): BotSlackResult<T> {
  return !result.ok && result.status === 404 && result.error === null
    ? { ok: false, error: BOT_LINEAR_OFF }
    : answer(result)
}

/** As for Linear: a bare 404 is a cloud with GitHub off. */
function gitHubAnswer<T>(result: ConnectorResult<T>): BotSlackResult<T> {
  return !result.ok && result.status === 404 && result.error === null
    ? { ok: false, error: BOT_GITHUB_OFF }
    : answer(result)
}

function sourceAnswer(
  source: ConnectorConnectSource
): <T>(result: ConnectorResult<T>) => BotSlackResult<T> {
  return source === 'linear' ? linearAnswer : gitHubAnswer
}

/** A cloud with bots off, or from before access requests, has none to list. */
function accessListAnswer(
  result: ConnectorResult<ConnectorAccessRequestList>
): BotSlackResult<ConnectorAccessRequestList> {
  return !result.ok && result.status === 404 && result.error === null
    ? { ok: true, value: { requests: [] } }
    : answer(result)
}

export function botsCloudClient(cloud: Pick<ConnectorCloud, 'call'>) {
  const linearWorkspace = (workspaceId: string): string =>
    `${CONNECTOR_PATHS.linear}/workspaces/${encodeURIComponent(workspaceId)}`
  const botSlack = (botId: string): string =>
    `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/slack`
  return {
    /** Hands the cloud a config refresh token; it keeps only its rotation, encrypted, for this workspace. */
    saveSlackGrant: async (refreshToken: string) =>
      answer(
        await cloud.call(
          CONNECTOR_PATHS.slackGrants,
          { v: 1, refreshToken },
          ConnectorSlackGrantResponse
        )
      ),
    forgetSlackGrant: async (teamId: string) =>
      answer(
        await cloud.call(
          `${CONNECTOR_PATHS.slackGrants}/${encodeURIComponent(teamId)}`,
          undefined,
          z.undefined(),
          { method: 'DELETE' }
        )
      ),
    /** Creates or resumes the bot's app; the link installs it. */
    setUpSlackApp: async (botId: string, teamId: string) =>
      answer(
        await cloud.call(
          `${botSlack(botId)}/apps`,
          { v: 1, teamId },
          ConnectorBotSlackAppResponse,
          {
            timeoutMs: APP_SETUP_TIMEOUT_MS
          }
        )
      ),
    /** What messages typed at the bot's computer post as there, at once or once approved in Slack. */
    setSlackPostAs: async (botId: string, request: ConnectorBotSlackPostAsRequest) =>
      answer(
        'cancel' in request
          ? await cloud.call(`${botSlack(botId)}/post-as`, request, z.undefined())
          : await cloud.call(
              `${botSlack(botId)}/post-as`,
              request,
              ConnectorBotSlackPostAsResponse,
              { timeoutMs: APP_SETUP_TIMEOUT_MS }
            )
      ),
    /** Whether new replies in this workspace end with the "Open this thread in Orca" link. */
    setSlackThreadLink: async (botId: string, request: ConnectorBotSlackThreadLinkRequest) =>
      answer(
        await cloud.call(`${botSlack(botId)}/thread-link`, request, z.undefined(), {
          method: 'PUT'
        })
      ),
    /** A one-time code another signed-in Orca account redeems to create this bot's app with its own grant. */
    handOffSlackApp: async (botId: string, teamId: string) =>
      answer(
        await cloud.call(
          `${botSlack(botId)}/handoffs`,
          { v: 1, teamId },
          ConnectorBotSlackHandOffResponse
        )
      ),
    /** Creates the app the code names with this account's grant; the bot and workspace come from the code. */
    redeemSlackHandOff: async (code: string) =>
      answer(
        await cloud.call(SLACK_HAND_OFF_REDEEM, { v: 1, code }, ConnectorBotSlackAppResponse, {
          timeoutMs: APP_SETUP_TIMEOUT_MS
        })
      ),
    /** Without a team, the bot's first workspace; an older cloud knows only that one. */
    slackState: async (botId: string, teamId?: string) =>
      answer(
        await cloud.call(
          `${botSlack(botId)}${teamQuery(teamId, '?')}`,
          undefined,
          ConnectorBotSlackStateResponse,
          { method: 'GET' }
        )
      ),
    /** Stops new work from Slack in that workspace, or in every one; the app itself stays in Slack. */
    removeSlackApp: async (botId: string, teamId?: string) =>
      answer(
        await cloud.call(`${botSlack(botId)}${teamQuery(teamId, '?')}`, undefined, z.undefined(), {
          method: 'DELETE'
        })
      ),
    /** The bot's picture; the cloud sets its Slack app's icon from it. */
    setAvatar: async (botId: string, avatar: ConnectorBotAvatarRequest) =>
      answer(
        await cloud.call(
          `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/avatar`,
          avatar,
          z.undefined(),
          { method: 'PUT' }
        )
      ),
    slackMembers: async (botId: string, query: string, teamId?: string) =>
      answer(
        await cloud.call(
          `${botSlack(botId)}/members?q=${encodeURIComponent(query)}${teamQuery(teamId, '&')}`,
          undefined,
          ConnectorBotSlackMembersResponse,
          { method: 'GET' }
        )
      ),
    linearState: async () =>
      linearAnswer(
        await cloud.call(`${CONNECTOR_PATHS.linear}/state`, undefined, ConnectorLinearState, {
          method: 'GET'
        })
      ),
    unlinkLinear: async (workspaceId: string) =>
      linearAnswer(
        await cloud.call(linearWorkspace(workspaceId), undefined, z.undefined(), {
          method: 'DELETE'
        })
      ),
    linearMembers: async (workspaceId: string, query: string) =>
      linearAnswer(
        await cloud.call(
          `${linearWorkspace(workspaceId)}/members?q=${encodeURIComponent(query)}`,
          undefined,
          ConnectorLinearMembersResponse,
          { method: 'GET' }
        )
      ),
    /** Null clears it, so a request naming no bot asks which one. */
    setLinearDefaultBot: async (workspaceId: string, botId: string | null) =>
      linearAnswer(
        await cloud.call(
          `${linearWorkspace(workspaceId)}/default-bot`,
          { v: 1, botId },
          z.undefined(),
          { method: 'PUT' }
        )
      ),
    /** Starts the one-trip sign-in; it returns to `loopback` or, without one, to orca://<source>/link. */
    startConnect: async (
      source: ConnectorConnectSource,
      options: {
        loopback: { port: number; nonce: string } | null
        switchAccount: boolean
        loginKey?: string
      }
    ) =>
      sourceAnswer(source)(
        await cloud.call(
          `${CONNECTOR_PATHS[source]}/connect`,
          // The contract's own check: a loopback whole or not at all, switchAccount only when set.
          ConnectorConnectStartRequestSchema.parse({
            v: 1,
            ...(options.loopback
              ? { loopbackPort: options.loopback.port, loopbackNonce: options.loopback.nonce }
              : {}),
            ...(options.switchAccount ? { switchAccount: true } : {}),
            ...(options.loginKey ? { loginKey: options.loginKey } : {})
          }),
          ConnectorConnectStartSchema
        )
      ),
    /** Spends the trip's one-time result and links its account, in one step. */
    redeemConnect: async (source: ConnectorConnectSource, result: string) =>
      sourceAnswer(source)(
        await cloud.call(
          `${CONNECTOR_PATHS[source]}/connect/redeem`,
          ConnectorConnectRedeemRequestSchema.parse({ v: 1, result }),
          ConnectorConnectRedeemSchema
        )
      ),
    /** The account's pending access requests, newest first. */
    accessRequests: async () =>
      accessListAnswer(
        await cloud.call(CONNECTOR_PATHS.accessRequests, undefined, ConnectorAccessRequestList, {
          method: 'GET'
        })
      ),
    /** Opens a request from the owner's link, once; the cloud refuses any other account, and leaves a token for a bot not in botIds unspent. */
    redeemAccessRequest: async (token: string, botIds: readonly string[]) =>
      answer(
        await cloud.call(
          `${CONNECTOR_PATHS.accessRequests}/redeem`,
          { v: 1, token, botIds },
          ConnectorAccessRequest
        )
      ),
    decideAccessRequest: async (requestId: string, decision: BotAccessDecision) =>
      answer(
        await cloud.call(
          `${CONNECTOR_PATHS.accessRequests}/${encodeURIComponent(requestId)}/decision`,
          { v: 1, decision },
          z.undefined()
        )
      ),
    githubState: async () =>
      gitHubAnswer(
        await cloud.call(`${CONNECTOR_PATHS.github}/state`, undefined, ConnectorGitHubState, {
          method: 'GET'
        })
      ),
    /** One linked GitHub user; none unlinks the account as an older cloud does. */
    unlinkGitHub: async (userId?: string) =>
      gitHubAnswer(
        await cloud.call(
          `${CONNECTOR_PATHS.github}/link${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`,
          undefined,
          z.undefined(),
          { method: 'DELETE' }
        )
      ),
    githubUsers: async (query: string) =>
      gitHubAnswer(
        await cloud.call(
          `${CONNECTOR_PATHS.github}/users?q=${encodeURIComponent(query)}`,
          undefined,
          ConnectorGitHubUsersResponse,
          { method: 'GET' }
        )
      ),
    /** Null clears it, so a comment naming none asks which one; `userId` picks the linked user. */
    setGitHubDefaultBot: async (botId: string | null, userId?: string) =>
      gitHubAnswer(
        await cloud.call(
          `${CONNECTOR_PATHS.github}/default-bot`,
          userId ? { v: 1, botId, userId } : { v: 1, botId },
          z.undefined(),
          { method: 'PUT' }
        )
      )
  }
}

export type BotsCloudClient = ReturnType<typeof botsCloudClient>

/** Runs `run` as the signed-in account; signed out, answers so without calling the cloud. */
export async function withBotsCloudClient<T>(
  cloud: Pick<ConnectorCloud, 'call'> | null,
  run: (client: BotsCloudClient) => Promise<BotSlackResult<T>>
): Promise<BotSlackResult<T>> {
  return cloud
    ? await run(botsCloudClient(cloud))
    : { ok: false, error: BOT_SLACK_DESKTOP_ERRORS.signedOut }
}
