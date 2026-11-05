import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  claudeStateFileAsync,
  readClaudeFolderLoginAsync
} from '../claude-accounts/claude-account-folder'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

// Symbols survive host cache copies without putting account homes or credential revisions on the wire.
const observationKey = Symbol('claude-subscription-observation')

type ClaudeSubscriptionObservation = {
  home: string
  identity: string
  credentialRevision: string
  observedAt: number
  windowsComplete: boolean
}

type ObservedLimits = ProviderRateLimits & {
  [observationKey]?: ClaudeSubscriptionObservation
}

export async function claudeSubscriptionIdentity(home: string, token: string) {
  const canonicalHome = await realpath(home)
  const login = await readClaudeFolderLoginAsync(await claudeStateFileAsync(canonicalHome))
  if (!login?.email || !login.organizationUuid) {
    return null
  }
  return {
    home: canonicalHome,
    identity: JSON.stringify([login.email.toLowerCase(), login.organizationUuid]),
    credentialRevision: createHash('sha256').update(token).digest('hex')
  }
}

export function observeClaudeSubscription(
  limits: ProviderRateLimits,
  observation: ClaudeSubscriptionObservation
): ProviderRateLimits {
  return Object.assign(limits, { [observationKey]: observation })
}

export function readClaudeSubscriptionObservation(limits: ProviderRateLimits | null | undefined) {
  const observed: ObservedLimits | null | undefined = limits
  return observed?.[observationKey]
}

export function isSameClaudeSubscriptionHome(home: string, observedHome: string | undefined) {
  return (
    observedHome !== undefined &&
    normalizeRuntimePathForComparison(home) === normalizeRuntimePathForComparison(observedHome)
  )
}
