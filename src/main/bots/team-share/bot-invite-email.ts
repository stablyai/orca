// The invite email for someone a bot was just shared with, sent by Orca Cloud's sign-in service as
// this host's signed-in account (the bot's owner). Only the email: the share stands either way.
import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import { mascotAvatar, parseBotAvatar } from '../../../shared/bot-avatar'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../../../shared/bot-types'
import { OrcaCloudRequestError } from '../../orca-profiles/cloud-auth/profile-cloud-client'

const INVITE_TIMEOUT_MS = 15_000
const InviteAnswer = z.object({ sent: z.boolean() })

/** The services an invite email says the bot can be asked on, besides Orca. */
export type BotInviteConnector = 'slack' | 'github' | 'linear'

export type BotInviteEmail = {
  to: string
  agentName: string
  /** `mascot:<id>`, shown as that mascot; an uploaded picture stays on this computer, so the email
   *  shows the bot's initial. */
  avatar?: string
  connectors: BotInviteConnector[]
}

/** The invite email for one address: the bot's name, its mascot, and where it answers. */
export function botInviteEmail(
  bot: Pick<
    Bot,
    'name' | 'avatar' | 'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'github'
  >,
  to: string
): BotInviteEmail {
  const picture = parseBotAvatar(bot.avatar)
  const connected: [boolean, BotInviteConnector][] = [
    [botSlackApps(bot).length > 0, 'slack'],
    [bot.github !== null, 'github'],
    [botLinearWorkspaces(bot).length > 0, 'linear']
  ]
  return {
    to,
    agentName: bot.name,
    ...(picture?.kind === 'mascot' ? { avatar: mascotAvatar(picture.id) } : {}),
    connectors: connected.filter(([on]) => on).map(([, connector]) => connector)
  }
}

/** A call as the host's signed-in account, with its access token and the sign-in service's address. */
export type BotInviteCloudCall = <T>(
  operation: (accessToken: string, apiBaseUrl: string) => Promise<T>
) => Promise<{ status: 'ok'; value: T } | { status: 'reconnect-required' }>

/** One invite request; a rejected access token throws so the session refreshes and retries once. */
export async function postBotInvite(
  apiBaseUrl: string,
  accessToken: string,
  invite: BotInviteEmail,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const response = await fetchImpl(`${apiBaseUrl}/v1/desktop/agent-invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    // One id per send, so the cloud's retry of this request mails once.
    body: JSON.stringify({ ...invite, requestId: randomUUID() }),
    redirect: 'error',
    signal: AbortSignal.timeout(INVITE_TIMEOUT_MS)
  })
  if (response.status === 401) {
    throw new OrcaCloudRequestError(401)
  }
  // Past its hourly limit (429), on an older cloud with no such route (404), and in log mode or on
  // a refusal (sent: false), the email waits for Resend.
  if (!response.ok) {
    return false
  }
  const answer = InviteAnswer.safeParse(await response.json().catch(() => null))
  return answer.data?.sent === true
}

/** Whether the email went out; false (Email not sent yet) on a host with no Orca Cloud. Never
 *  throws, since a share is never refused for its email. */
export async function sendBotInviteEmail(
  call: BotInviteCloudCall | null,
  invite: BotInviteEmail
): Promise<boolean> {
  if (!call) {
    return false
  }
  try {
    const result = await call((token, apiBaseUrl) => postBotInvite(apiBaseUrl, token, invite))
    return result.status === 'ok' && result.value
  } catch (error) {
    console.warn('[bots] invite email not sent:', error instanceof Error ? error.message : error)
    return false
  }
}
