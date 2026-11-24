// The invite email for someone a bot was just shared with, sent by Orca Cloud's sign-in service as
// this host's signed-in account (the bot's owner). Only the email: the share stands either way.
import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import { getOrcaCloudAuthConfig } from '../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../../orca-profiles/cloud-auth/profile-cloud-client'
import type { BotCloudAuth } from '../sharing/bot-share-client'

const INVITE_TIMEOUT_MS = 15_000
const InviteAnswer = z.object({ sent: z.boolean() })

export type BotInviteEmail = { to: string; agentName: string }

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

/** Whether the email went out; never throws, since a share is never refused for its email. */
export async function sendBotInviteEmail(
  auth: BotCloudAuth,
  invite: BotInviteEmail
): Promise<boolean> {
  try {
    const config = getOrcaCloudAuthConfig()
    if (!config.configured) {
      return false
    }
    // The same signed-in session as the bot's other cloud calls, on the sign-in service's address.
    const result = await auth((token) => postBotInvite(config.config.apiBaseUrl, token, invite))
    return result.status === 'ok' && result.value
  } catch (error) {
    console.warn('[bots] invite email not sent:', error instanceof Error ? error.message : error)
    return false
  }
}
