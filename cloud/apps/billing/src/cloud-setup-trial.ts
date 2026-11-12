// The setup session's view of the one-time trial (N11, owned by src/trial.ts). Kept behind this
// port so the setup flow reads one shape whatever the trial module returns.
import type { Env } from './env'
import { grantTrial, trialIncludedSeconds, trialRow, trialState } from './trial'

export type SetupTrial = { includedSeconds: number; usedSeconds: number; exhausted: boolean }

export type TrialGrantInput = {
  accountId: string
  userId: string
  email?: string
  emailVerified?: boolean
  githubUserId?: number
  githubOwnerId?: number
  ip?: string
}

export type TrialPort = {
  /** Sandbox seconds a new team's trial includes, or null when no trial is offered at all. */
  offeredSeconds(env: Env, now: number): number | null | Promise<number | null>
  /** The account's trial, or null when it has none (or a plan ended it). */
  current(env: Env, accountId: string, now: number): Promise<SetupTrial | null>
  /** Grants the trial if this account and user may still get one. Idempotent. */
  grant(env: Env, input: TrialGrantInput, now: number): Promise<{ ok: true; trial: SetupTrial } | { ok: false; reason: string }>
}

/** No trial backend: every team goes through a plan. Replaced by the trial module's port. */
export const noTrialPort: TrialPort = {
  offeredSeconds: () => null,
  current: async () => null,
  grant: async () => ({ ok: false, reason: 'trial_unavailable' })
}

/** The trial module (N11) as the setup session sees it. */
export const billingTrialPort: TrialPort = {
  offeredSeconds: (env, now) => trialIncludedSeconds(env, now),
  async current(env, accountId) {
    const row = await trialRow(env.BILLING_DB, accountId)
    if (!row || row.revoked_at !== null) {
      return null
    }
    const state = trialState(row)
    return { includedSeconds: state.includedSeconds, usedSeconds: state.usedSeconds, exhausted: state.exhausted }
  },
  async grant(env, input, now) {
    const outcome = await grantTrial(
      env,
      {
        accountId: input.accountId,
        userId: input.userId,
        ...(input.email ? { email: input.email } : {}),
        ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
        ...(input.githubUserId ? { githubUserId: String(input.githubUserId) } : {}),
        ...(input.githubOwnerId ? { githubOwnerId: String(input.githubOwnerId) } : {}),
        ...(input.ip ? { ip: input.ip } : {})
      },
      now
    )
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason }
    }
    const state = outcome.trial
    return { ok: true, trial: { includedSeconds: state.includedSeconds, usedSeconds: state.usedSeconds, exhausted: state.exhausted } }
  }
}
