/** Share host-local key ownership across IPC/RPC so paired clients save where usage polling runs; remain Electron-free. */
import {
  clearZcodePlanApiKey,
  getZcodePlanApiKeyProtection,
  hasZcodePlanApiKey,
  API_KEY_ENVELOPE_PREFIX,
  getZcodePlanApiKeyPath,
  saveZcodePlanApiKey
} from './zcode-plan-api-key-store'
import {
  refuseCredentialSealedElsewhere,
  savedCredentialUnreadable
} from '../credentials/saved-credential-readability'
import { hasZcodeCliPlanCredentials } from '../rate-limits/zcode-usage-fetcher'
import { refreshAfterCredentialChange } from '../ipc/credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service'
import type { ZcodePlanCredentialsStatus } from '../../shared/zcode-plan-sites'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateZcodeCredentialState'>

export function getZcodePlanCredentialsStatus(): ZcodePlanCredentialsStatus {
  const apiKeyConfigured = hasZcodePlanApiKey()
  return {
    apiKeyConfigured,
    zcodeCliConfigured: hasZcodeCliPlanCredentials(),
    apiKeyProtection: getZcodePlanApiKeyProtection(),
    apiKeyUnreadable: apiKeyConfigured ? apiKeyUnreadable() : undefined
  }
}

function apiKeyUnreadable(): ReturnType<typeof savedCredentialUnreadable> {
  return savedCredentialUnreadable({
    path: getZcodePlanApiKeyPath(),
    envelopePrefix: API_KEY_ENVELOPE_PREFIX
  })
}

/** Reject save when this host cannot open the existing seal; forgetting remains allowed. */
export function assertZcodePlanApiKeyOpensHere(): void {
  if (apiKeyUnreadable() === 'sealed-elsewhere') {
    refuseCredentialSealedElsewhere('GLM Coding Plan API key')
  }
}

function refreshAfterChange(rateLimits: UsageRefresher | null, action: 'save' | 'clear'): void {
  refreshAfterCredentialChange(
    rateLimits,
    (service) => service.invalidateZcodeCredentialState(),
    `[zcode] failed to trigger rate-limit refresh after ${action}:`
  )
}

export function saveZcodePlanApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): ZcodePlanCredentialsStatus {
  // Runtime-check IPC/RPC input; compile-time types do not constrain the wire.
  if (typeof key !== 'string') {
    throw new Error('GLM Coding Plan API key must be a string')
  }
  saveZcodePlanApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getZcodePlanCredentialsStatus()
}

export function clearZcodePlanApiKeyCredential(
  rateLimits: UsageRefresher | null
): ZcodePlanCredentialsStatus {
  clearZcodePlanApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getZcodePlanCredentialsStatus()
}
