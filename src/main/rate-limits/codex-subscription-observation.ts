import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { CodexRateLimitWindowsSnapshot } from './codex-rate-limit-window-classification'
import { readCodexAuthIdentity } from '../codex-accounts/codex-auth-identity'

const observationKey = Symbol('codex-subscription-observation')
const windowsKey = Symbol('codex-subscription-windows')
type CodexSubscriptionObservation = {
  home: string
  identity: string
  credentialRevision: string
  observedAt: number
}

type ObservedLimits = ProviderRateLimits & {
  [observationKey]?: CodexSubscriptionObservation
  [windowsKey]?: boolean
}

export function readCodexSubscriptionIdentity(home: string) {
  try {
    const contents = readFileSync(join(home, 'auth.json'), 'utf8')
    const auth = JSON.parse(contents)
    if (auth.OPENAI_API_KEY || auth.auth_mode !== 'chatgpt') {
      return null
    }
    const identity = readCodexAuthIdentity(contents)
    if (!identity?.providerAccountId || !auth.tokens?.access_token) {
      return null
    }
    return {
      home: realpathSync(home),
      identity: JSON.stringify([identity.providerAccountId, identity.workspaceAccountId]),
      credentialRevision: createHash('sha256').update(contents).digest('hex')
    }
  } catch {
    return null
  }
}

export function observeCodexSubscriptionWindows(
  limits: ProviderRateLimits,
  raw?: CodexRateLimitWindowsSnapshot | null
) {
  const windows = [raw?.primary, raw?.secondary]
  const durations = windows.map((w) => w?.windowDurationMins)
  const valid =
    durations.includes(300) &&
    durations.includes(10080) &&
    windows.every(
      (w) =>
        typeof w?.usedPercent === 'number' &&
        Number.isFinite(w.usedPercent) &&
        w.usedPercent >= 0 &&
        w.usedPercent <= 100 &&
        (w.resetsAt == null || (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)))
    )
  return Object.assign(limits, { [windowsKey]: valid })
}

export function observeCodexSubscription(
  limits: ProviderRateLimits,
  identity: Omit<CodexSubscriptionObservation, 'observedAt'>
) {
  const observed: ObservedLimits = limits
  return observed[windowsKey] === true
    ? Object.assign(limits, { [observationKey]: { ...identity, observedAt: limits.updatedAt } })
    : limits
}

export function readCodexSubscriptionObservation(limits: ProviderRateLimits | null | undefined) {
  const observed: ObservedLimits | null | undefined = limits
  return observed?.[observationKey]
}
