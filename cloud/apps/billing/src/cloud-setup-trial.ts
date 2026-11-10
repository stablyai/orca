// The setup session's view of the one-time trial (N11, owned by src/trial.ts). Kept behind this
// port so the setup flow reads one shape whatever the trial module returns.
import type { Env } from './env'

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
  offeredSeconds(env: Env): number | null
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
