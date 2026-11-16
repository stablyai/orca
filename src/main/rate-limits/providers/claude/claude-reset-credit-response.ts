import { z } from 'zod'
import type { ClaudeResetCredits } from '../../../../shared/agent-accounts/claude/claude-reset-credit-types'

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform(Date.parse)
  .nullish()
const windowNames = z.array(z.string().min(1).max(120))
const grantSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  resets_total: z.number().int().nonnegative(),
  resets_left: z.number().int().nonnegative(),
  starts_at: timestamp,
  ends_at: timestamp,
  clears: windowNames,
  paused: z.boolean(),
  usable_now: z.boolean(),
  use_requires_limit: z.boolean().optional(),
  blocking: windowNames
})
const creditsSchema = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().nullable().optional(),
  at_limit: z.boolean().optional(),
  next_grant_id: z.string().nullable().optional(),
  cooldown_until: timestamp,
  grants: z
    .array(grantSchema)
    .refine((grants) => new Set(grants.map((grant) => grant.id)).size === grants.length)
})

export function mapClaudeResetCredits(value: unknown): ClaudeResetCredits | null {
  const parsed = creditsSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const data = parsed.data
  return {
    eligible: data.eligible,
    ineligibleReason: data.ineligible_reason ?? null,
    atLimit: data.at_limit === true,
    nextGrantId: data.next_grant_id ?? null,
    cooldownUntil: data.cooldown_until ?? null,
    grants: data.grants.map((grant) => ({
      id: grant.id,
      label: grant.label,
      resetsTotal: grant.resets_total,
      resetsLeft: grant.resets_left,
      startsAt: grant.starts_at ?? null,
      endsAt: grant.ends_at ?? null,
      clears: grant.clears,
      paused: grant.paused,
      usableNow: grant.usable_now,
      useRequiresLimit: grant.use_requires_limit !== false,
      blocking: grant.blocking
    }))
  }
}
