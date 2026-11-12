// ENTITLEMENTS_MODE (env.ts): which source plan terms come from. Its own module so any file can
// read it without an import cycle through entitlements.ts.
import type { Env } from './env'

export type EntitlementsMode = 'off' | 'shadow' | 'on'

export function entitlementsMode(env: Pick<Env, 'ENTITLEMENTS_MODE'>): EntitlementsMode {
  const mode = env.ENTITLEMENTS_MODE?.trim()
  return mode === 'shadow' || mode === 'on' ? mode : 'off'
}
