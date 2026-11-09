// Seat count source of truth: Orca Cloud auth's org membership (org_memberships rows; pending
// invites excluded). Auth pushes changes to POST /v1/internal/seats; billing also pulls the live
// count when it needs one (Checkout, the reconcile cron) so a missed push self-heals.
import { z } from 'zod'
import type { Env } from './env'

const MemberCountResponse = z.object({ orgId: z.string(), members: z.number().int().min(0) })

export class MembershipUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MembershipUnavailableError'
  }
}

/** Live member count from auth, or null when no auth URL is configured (local dev and tests). */
export type MembershipSource = (orgId: string) => Promise<number | null>

export function authMembershipSource(env: Env, fetchImpl: typeof fetch = fetch): MembershipSource {
  return async (orgId) => {
    if (!env.AUTH_INTERNAL_URL) {
      return null
    }
    if (!env.MEMBERSHIP_SYNC_TOKEN) {
      throw new MembershipUnavailableError('membership token not configured')
    }
    let response: Response
    try {
      response = await fetchImpl(new URL('/v1/internal/billing/org-members', env.AUTH_INTERNAL_URL), {
        method: 'POST',
        headers: { authorization: `Bearer ${env.MEMBERSHIP_SYNC_TOKEN.split(',')[0]!.trim()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      throw new MembershipUnavailableError('auth unreachable')
    }
    // Dev only: AUTH_INTERNAL_URL points at staging auth, which does not know orgs from production
    // or operator dev tokens; those fall back to the Checkout request's quantity instead of failing.
    if (response.status === 404 && env.BILLING_ENV !== 'prod') {
      return null
    }
    if (!response.ok) {
      throw new MembershipUnavailableError(`auth answered ${response.status}`)
    }
    const parsed = MemberCountResponse.safeParse(await response.json().catch(() => null))
    if (!parsed.success || parsed.data.orgId !== orgId) {
      throw new MembershipUnavailableError('auth answered an unexpected body')
    }
    return parsed.data.members
  }
}

export function orgIdOf(accountId: string): string | null {
  return accountId.startsWith('org:') ? accountId.slice(4) : null
}
