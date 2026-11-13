// Is this person in this team right now? Asked of Orca Cloud auth, which answers from the live
// roster (auth's POST /v1/internal/org-membership). The control plane holds no member list of its
// own that may decide access: the names it stores are labels, and auth's pushes are best effort.
//
// Used before a workspace is handed to a new owner (OWNER-TRANSFER). Fails closed: anything but a
// clear "yes" refuses, and nothing here falls back to stored data.
//
// The bearer is derived, never the shared token itself: HMAC-SHA256 keyed with the token auth and
// the control plane already share (MEMBER_REMOVED_TOKEN here), over a fixed purpose string. Auth
// refuses the raw token on this route, and the derived key opens nothing on the control plane.
import { z } from 'zod'
import type { Env } from './env'

export const MEMBERSHIP_KEY_PURPOSE = 'orca-cloud:control-plane-to-auth:org-membership:v1'
/** Auth's own roster read is capped at 4 s. */
const TIMEOUT_MS = 6_000

export type MembershipAnswer =
  | { member: true }
  | { member: false }
  /** Auth could not say (down, slow, rate limited, misconfigured): refuse, and say try again. */
  | { unavailable: string }

export type TeamMembershipCheck = (accountId: string, userId: string) => Promise<MembershipAnswer>

const Answer = z.looseObject({ member: z.boolean() })

function base64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The bearer for auth's membership route, from the shared control-plane token. */
export async function membershipKey(sharedToken: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sharedToken.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(MEMBERSHIP_KEY_PURPOSE))))
}

/**
 * The live check. `unavailable` when it is not configured (no AUTH_INTERNAL_ORIGIN or no shared
 * token), for accounts auth does not know (personal and dev operator accounts), and for every
 * answer from auth other than 200 with `member` true or false.
 */
export function createTeamMembershipCheck(
  env: Pick<Env, 'AUTH_INTERNAL_ORIGIN' | 'MEMBER_REMOVED_TOKEN'>,
  fetchImpl: typeof fetch = fetch
): TeamMembershipCheck {
  return async (accountId, userId) => {
    const origin = env.AUTH_INTERNAL_ORIGIN?.replace(/\/+$/, '')
    const token = env.MEMBER_REMOVED_TOKEN?.trim()
    if (!origin || !origin.startsWith('https://') || !token || token.length < 32) {
      return { unavailable: 'not_configured' }
    }
    // Only real teams: a dev operator account (`dev:org:…`) is not in auth, and is refused.
    if (!accountId.startsWith('org:')) {
      return { unavailable: 'unknown_account' }
    }
    let response: Response
    try {
      response = await fetchImpl(`${origin}/v1/internal/org-membership`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await membershipKey(token)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: accountId.slice('org:'.length), userId }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      return { unavailable: 'unreachable' }
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      // 401/400: our bug. 404: auth has no such route (or no token). 429: rate limited. 502: its
      // directory could not answer. None of them is a "yes".
      return { unavailable: `auth_${response.status}` }
    }
    const parsed = Answer.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      return { unavailable: 'unreadable_answer' }
    }
    return { member: parsed.data.member }
  }
}
