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
import { hasZcodeCliPlanCredentials } from '../rate-limits/providers/zcode/zcode-usage-credentials'
import { refreshAfterCredentialChange } from '../ipc/accounts/credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { ZcodePlanCredentialsStatus } from '../../shared/agent-accounts/usage-credentials/zcode-plan-sites'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateZcodeCredentialState'>

export async function getZcodePlanCredentialsStatus(): Promise<ZcodePlanCredentialsStatus> {
  const apiKeyConfigured = await hasZcodePlanApiKey()
  return {
    apiKeyConfigured,
    zcodeCliConfigured: await hasZcodeCliPlanCredentials(),
    apiKeyProtection: await getZcodePlanApiKeyProtection(),
    apiKeyUnreadable: apiKeyConfigured ? await apiKeyUnreadable() : undefined
  }
}

async function apiKeyUnreadable(): Promise<ReturnType<typeof savedCredentialUnreadable>> {
  return savedCredentialUnreadable({
    path: getZcodePlanApiKeyPath(),
    envelopePrefix: API_KEY_ENVELOPE_PREFIX
  })
}

/** Reject save when this host cannot open the existing seal; forgetting remains allowed. */
export async function assertZcodePlanApiKeyOpensHere(): Promise<void> {
  if ((await apiKeyUnreadable()) === 'sealed-elsewhere') {
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

export async function saveZcodePlanApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): Promise<ZcodePlanCredentialsStatus> {
  // Runtime-check IPC/RPC input; compile-time types do not constrain the wire.
  if (typeof key !== 'string') {
    throw new Error('GLM Coding Plan API key must be a string')
  }
  await saveZcodePlanApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getZcodePlanCredentialsStatus()
}

export async function clearZcodePlanApiKeyCredential(
  rateLimits: UsageRefresher | null
): Promise<ZcodePlanCredentialsStatus> {
  await clearZcodePlanApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getZcodePlanCredentialsStatus()
}
