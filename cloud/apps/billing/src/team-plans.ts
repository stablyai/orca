// A user signed in on their personal account (or another team) may belong to a
// team that already has a plan. The desktop offers "Switch to <team>" instead of a purchase, so it
// needs each listed team's plan state, read with the caller's own billing token and NO credential
// for those teams. Membership (live provider roster) and the team's billing flag come from Orca
// Cloud auth's internal org-member check, which takes the user from that same billing token (so
// only tokens auth itself signed qualify); a team the caller isn't on is simply left out.
import { z } from 'zod'
import { computeEntitlement } from './entitlements'
import type { Env } from './env'

/** At most this many teams per request: an account menu's worth, and a bound on auth lookups. */
export const TEAM_PLANS_MAX_ORGS = 10

const OrgId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
export const TeamPlansRequestSchema = z
  .object({ orgIds: z.array(OrgId).min(1).max(TEAM_PLANS_MAX_ORGS) })
  .strict()

export type OrgMemberAnswer = { member: boolean; billingEnabled?: boolean }
/**
 * Is the holder of `billingToken` on `orgId`? Null when auth can't or won't answer (unconfigured,
 * unreachable, a token auth didn't sign, an unexpected body): fail closed.
 */
export type OrgMemberCheck = (orgId: string, billingToken: string) => Promise<OrgMemberAnswer | null>

const MemberAnswerSchema = z.object({
  orgId: z.string(),
  member: z.boolean(),
  billingEnabled: z.boolean().optional()
})

export function authOrgMemberCheck(env: Env, fetchImpl: typeof fetch = fetch): OrgMemberCheck {
  return async (orgId, billingToken) => {
    const token = env.MEMBERSHIP_SYNC_TOKEN?.split(',')[0]?.trim()
    if (!env.AUTH_INTERNAL_URL || !token) {
      return null
    }
    try {
      const response = await fetchImpl(new URL('/v1/internal/billing/org-member', env.AUTH_INTERNAL_URL), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, billingToken }),
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000)
      })
      if (!response.ok) {
        return null
      }
      const parsed = MemberAnswerSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success || parsed.data.orgId !== orgId) {
        return null
      }
      const { member, billingEnabled } = parsed.data
      return { member, ...(billingEnabled !== undefined ? { billingEnabled } : {}) }
    } catch {
      return null
    }
  }
}

export type TeamPlanSummary = {
  orgId: string
  /** The team's plan, or null when it has none (or it lapsed). */
  plan: string | null
  planLabel: string | null
  /** Whether a sandbox could start on this team right now (plan active, hours or overage left). */
  canStartSandbox: boolean
}

/**
 * Plan state for each listed team the caller is a member of, with billing on. Only what the
 * switch row needs: no usage, seats, payment or spend detail for a team the caller isn't using.
 */
export async function teamPlans(
  env: Pick<Env, 'BILLING_DB' | 'BILLING_PLANS'>,
  /** The caller's own billing token (already verified here); auth re-verifies it and names the user. */
  billingToken: string,
  orgIds: readonly string[],
  check: OrgMemberCheck,
  now: number
): Promise<{ teams: TeamPlanSummary[] }> {
  const unique = [...new Set(orgIds)]
  const answers = await Promise.all(unique.map(async (orgId) => ({ orgId, answer: await check(orgId, billingToken) })))
  const teams: TeamPlanSummary[] = []
  for (const { orgId, answer } of answers) {
    if (!answer?.member || answer.billingEnabled !== true) {
      continue
    }
    const entitlement = await computeEntitlement(env, `org:${orgId}`, now)
    teams.push({
      orgId,
      plan: entitlement.plan,
      planLabel: entitlement.planLabel,
      canStartSandbox: entitlement.canStartSandbox
    })
  }
  return { teams }
}
