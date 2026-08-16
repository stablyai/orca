import type { IPtyProvider } from '../providers/pty-provider-contract'

export const SKILL_SSH_REQUEST_TIMEOUT_MS = 5 * 60_000

const DIRECT_DOWNLOAD_FAILURE = 'skill-download-transport-failed'
const DEVELOPMENT_DOWNLOAD_POLICY_FAILURES = new Set([
  'skill-download-url-rejected',
  'skill-download-origin-rejected'
])

export type SkillSshRelayClient = NonNullable<IPtyProvider['requestHostRpc']>

export function requireSkillSshRelayClient(provider: IPtyProvider): SkillSshRelayClient {
  if (!provider.requestHostRpc) {
    throw new Error('skill-install-ssh-relay-unavailable')
  }
  return provider.requestHostRpc
}

export function shouldUseSkillSshClientTransfer(error: unknown, requireHttps: boolean): boolean {
  const message = error instanceof Error ? error.message : ''
  return (
    message === DIRECT_DOWNLOAD_FAILURE ||
    (!requireHttps && DEVELOPMENT_DOWNLOAD_POLICY_FAILURES.has(message))
  )
}

export function retryableSkillSshTransportError(error: unknown): boolean {
  return (
    typeof (error as { code?: unknown })?.code !== 'number' &&
    (error as Error)?.name !== 'AbortError'
  )
}

export async function skillSshRelayCapabilities(client: SkillSshRelayClient): Promise<string[]> {
  const status = (await client('relay.status', {}, { timeoutMs: 15_000 })) as {
    capabilities?: unknown
  }
  return Array.isArray(status.capabilities)
    ? status.capabilities.filter((value): value is string => typeof value === 'string')
    : []
}
