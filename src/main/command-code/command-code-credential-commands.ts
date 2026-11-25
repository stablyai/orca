import {
  clearCommandCodeApiKey,
  commandCodeApiKeyEnvelopeFile,
  hasCommandCodeApiKey,
  saveCommandCodeApiKey
} from './command-code-api-key-store'
import {
  refuseCredentialSealedElsewhere,
  savedCredentialUnreadable
} from '../credentials/saved-credential-readability'
import { refreshAfterCredentialChange } from '../ipc/accounts/credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { CommandCodeCredentialsStatus } from '../../shared/agent-accounts/usage-credentials/command-code-credentials'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateCommandCodeCredentialState'>

/** Reject save when this host cannot open the existing seal; forgetting remains allowed. */
export async function assertCommandCodeApiKeyOpensHere(): Promise<void> {
  const file = commandCodeApiKeyEnvelopeFile()
  const unreadable = await savedCredentialUnreadable({
    path: file.path,
    envelopePrefix: file.envelopePrefix
  })
  if (unreadable === 'sealed-elsewhere') {
    refuseCredentialSealedElsewhere('Command Code API key')
  }
}

export async function getCommandCodeCredentialsStatus(): Promise<CommandCodeCredentialsStatus> {
  return { apiKeyConfigured: await hasCommandCodeApiKey() }
}

function refreshAfterChange(rateLimits: UsageRefresher | null, action: 'save' | 'clear'): void {
  refreshAfterCredentialChange(
    rateLimits,
    (service) => service.invalidateCommandCodeCredentialState(),
    `[command-code] failed to trigger rate-limit refresh after ${action}:`
  )
}

export async function saveCommandCodeApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): Promise<CommandCodeCredentialsStatus> {
  // Runtime-check IPC/RPC input; compile-time types do not constrain the wire.
  if (typeof key !== 'string') {
    throw new Error('Command Code API key must be a string')
  }
  await saveCommandCodeApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getCommandCodeCredentialsStatus()
}

export async function clearCommandCodeApiKeyCredential(
  rateLimits: UsageRefresher | null
): Promise<CommandCodeCredentialsStatus> {
  await clearCommandCodeApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getCommandCodeCredentialsStatus()
}
