// Dev-only routes and behaviors (operator/seed/dev-sign-in/debug): an allowlist of environment names, so an
// unset SANDBOX_ENV, staging, prod or a typo all leave them off. Never `!== 'prod'`.
import type { Env } from './env'

export function devOnly(env: Pick<Env, 'SANDBOX_ENV'>): boolean {
  return env.SANDBOX_ENV === 'dev' || env.SANDBOX_ENV === 'local' || env.SANDBOX_ENV === 'test'
}
