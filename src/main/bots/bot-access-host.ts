// Request access asks for this host's bots, answered on the host as the desktop's Orca account, for any paired client.
import type { Bot } from '../../shared/bot-types'
import { botTakesAccessRequest, grantAccessRequest } from '../../shared/bots/bot-access-request'
import type {
  BotAccessDecision,
  BotAccessRedeemOutcome,
  ConnectorAccessRequest
} from '../../shared/connector-bot-access-contract'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../shared/connector-bot-slack-contract'
import type { BotUpdateParams } from '../../shared/rpc-contract/bots-params'
import { withBotsCloudClient } from '../connector-cloud/bots-cloud-client'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'

export type BotAccessHostDeps = {
  bots: () => readonly Bot[]
  /** Null when this host has no signed-in Orca account (orca serve today). */
  cloud: () => Pick<ConnectorCloud, 'call'> | null
  updateBot: (botId: string, edit: (bot: Bot) => BotUpdateParams['updates']) => Promise<Bot>
}

/** The runtime the desktop window and paired clients share. */
export type BotAccessRuntime = {
  bots: {
    list: () => readonly Bot[]
    update: (botId: string, edit: (bot: Bot) => BotUpdateParams['updates']) => Promise<Bot>
  }
  getConnectorCloud: () => Pick<ConnectorCloud, 'call'> | null
}

export function botAccessHost(runtime: BotAccessRuntime): BotAccessHostDeps {
  return {
    bots: () => runtime.bots.list(),
    cloud: () => runtime.getConnectorCloud(),
    updateBot: (botId, edit) => runtime.bots.update(botId, edit)
  }
}

/** Why a decision was not saved, beside the cloud's own codes. */
export const BOT_ACCESS_HOST_ERRORS = {
  /** The request is gone: answered, expired, or never this account's. */
  notWaiting: 'expired',
  /** Its bot is not on this host, or no longer takes requests from that connector and workspace. */
  notThisHost: 'not_this_host',
  /** The bot's list for that connector is full. */
  full: 'full',
  /** The cloud granted it but the member was not saved; deciding again retries just the add. */
  grantedNotAdded: 'granted_not_added'
} as const

/**
 * The account's waiting requests that this host's bots take. Each read also finishes any grant whose
 * add failed, since no screen shows a granted request to retry by hand.
 */
export async function listHostAccessRequests(
  deps: BotAccessHostDeps
): Promise<BotSlackResult<ConnectorAccessRequest[]>> {
  const listed = await readHostAccessRequests(deps)
  if (!listed.ok) {
    return listed
  }
  for (const request of listed.value.granted) {
    const bot = deps.bots().find((entry) => entry.id === request.botId)
    // Only a missing person is written; a grant waiting on the bot's next hello is left alone.
    if (bot && grantAccessRequest(bot, request).kind === 'add') {
      await addGrantedMember(deps, request, null, 'recovered')
    }
  }
  return { ok: true, value: listed.value.waiting }
}

/** Waiting requests, and recent grants whose person the bot does not list yet, for this host's bots. */
async function readHostAccessRequests(
  deps: BotAccessHostDeps
): Promise<
  BotSlackResult<{ waiting: ConnectorAccessRequest[]; granted: ConnectorAccessRequest[] }>
> {
  const listed = await withBotsCloudClient(deps.cloud(), (client) => client.accessRequests())
  if (!listed.ok) {
    return listed
  }
  const bots = deps.bots()
  const here = (request: ConnectorAccessRequest): boolean =>
    bots.some((bot) => botTakesAccessRequest(bot, request))
  return {
    ok: true,
    value: {
      waiting: listed.value.requests.filter(here),
      granted: (listed.value.granted ?? []).filter(here)
    }
  }
}

/**
 * The cloud's answer is authoritative: Grant is decided there first, so one that loses to a Decline
 * elsewhere adds no one, and only then adds the person to the bot's list for that connector.
 */
export async function decideHostAccessRequest(
  deps: BotAccessHostDeps,
  input: { requestId: string; decision: BotAccessDecision },
  deviceId: string | null
): Promise<BotSlackResult<undefined>> {
  // Re-read, so a client can only answer a request the account is still waiting on, for a bot on this host.
  const listed = await readHostAccessRequests(deps)
  if (!listed.ok) {
    return listed
  }
  const request = listed.value.waiting.find((entry) => entry.requestId === input.requestId)
  if (!request) {
    // Already granted in the cloud but the person is not listed yet: a retry finishes just the add.
    const granted = listed.value.granted.find((entry) => entry.requestId === input.requestId)
    return granted && input.decision === 'granted'
      ? await addGrantedMember(deps, granted, deviceId)
      : { ok: false, error: BOT_ACCESS_HOST_ERRORS.notWaiting }
  }
  if (input.decision === 'granted') {
    // Refused before the cloud is asked, so a grant this host cannot honour is never recorded.
    const refused = grantRefusal(deps, request)
    if (refused) {
      return { ok: false, error: refused }
    }
  }
  const decided = await withBotsCloudClient(deps.cloud(), (client) =>
    client.decideAccessRequest(request.requestId, input.decision)
  )
  // Who can ask decides who may make this host run commands, so the device that changed it is kept on record.
  console.info('[bots] access request answered', {
    botId: request.botId,
    requestId: request.requestId,
    decision: input.decision,
    saved: decided.ok,
    deviceId
  })
  if (!decided.ok || input.decision !== 'granted') {
    return decided
  }
  return await addGrantedMember(deps, request, deviceId)
}

function grantRefusal(
  deps: BotAccessHostDeps,
  request: ConnectorAccessRequest
): (typeof BOT_ACCESS_HOST_ERRORS)['full' | 'notThisHost'] | null {
  const bot = deps.bots().find((entry) => entry.id === request.botId)
  const grant = bot ? grantAccessRequest(bot, request) : ({ kind: 'not-this-bot' } as const)
  if (grant.kind === 'full') {
    return BOT_ACCESS_HOST_ERRORS.full
  }
  return grant.kind === 'not-this-bot' ? BOT_ACCESS_HOST_ERRORS.notThisHost : null
}

/** Idempotent: a person already listed is left as is. */
async function addGrantedMember(
  deps: BotAccessHostDeps,
  request: ConnectorAccessRequest,
  deviceId: string | null,
  trigger: 'decided' | 'recovered' = 'decided'
): Promise<BotSlackResult<undefined>> {
  const added = await saveGrantedMember(deps, request)
  console.info('[bots] access request member added', {
    botId: request.botId,
    requestId: request.requestId,
    added,
    trigger,
    deviceId
  })
  return added
    ? { ok: true, value: undefined }
    : { ok: false, error: BOT_ACCESS_HOST_ERRORS.grantedNotAdded }
}

async function saveGrantedMember(
  deps: BotAccessHostDeps,
  request: ConnectorAccessRequest
): Promise<boolean> {
  try {
    // Recomputed from the saved bot inside the controller's queue, so a concurrent edit is kept.
    const saved = await deps.updateBot(request.botId, (current) => {
      const latest = grantAccessRequest(current, request)
      return latest.kind === 'add' ? { members: latest.members } : {}
    })
    // Listed on the connector being granted, not merely under the same id on another.
    return grantAccessRequest(saved, request).kind === 'listed'
  } catch {
    return false
  }
}

/**
 * Opens a request from the owner's link. The token is single use, so the cloud spends it only for
 * a bot this host lists; a phone can try each host in turn.
 */
export async function redeemHostAccessRequest(
  deps: BotAccessHostDeps,
  link: { token: string; botId?: string }
): Promise<BotAccessRedeemOutcome> {
  const botIds = deps.bots().map((bot) => bot.id)
  // Checked here too, since an older cloud ignores botIds and would spend the token.
  if (botIds.length === 0 || (link.botId !== undefined && !botIds.includes(link.botId))) {
    return { kind: 'not-here' }
  }
  const cloud = deps.cloud()
  if (!cloud) {
    return { kind: 'unsupported' }
  }
  const redeemed = await withBotsCloudClient(cloud, (client) =>
    client.redeemAccessRequest(link.token, botIds)
  )
  if (redeemed.ok) {
    return { kind: 'redeemed', botId: redeemed.value.botId, request: redeemed.value }
  }
  switch (redeemed.error) {
    case 'not_owner':
      return { kind: 'not-owner' }
    case 'not_here':
      return { kind: 'not-here' }
    case 'expired':
      return { kind: 'expired' }
    case BOT_SLACK_DESKTOP_ERRORS.signedOut:
      return { kind: 'unsupported' }
    default:
      return { kind: 'failed' }
  }
}
