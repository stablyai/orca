import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { isProvenDeadProbe } from '../../shared/agent-session-lease-adjudication'
// Account deletion follows durable launcher references; unlink owns only the launcher record.
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProfileAgent } from '../../shared/agent-launch-profile'
export function assertAccountHasNoAgentProfiles(
  settings: Pick<GlobalSettings, 'agentLaunchProfiles'>,
  agent: ProfileAgent,
  accountId: string
): void {
  if (
    settings.agentLaunchProfiles?.some(
      (profile) =>
        profile.agent === agent &&
        profile.binding.kind === 'managed' &&
        profile.binding.accountId === accountId
    )
  ) {
    throw new Error(
      'Unlink this account’s agent profiles in Agent settings before removing the account.'
    )
  }
}

/** Historical records remain readable; only an admitted or uncertain execution keeps its home. */
export async function assertAccountHasNoStructuredProfileOwners(
  agent: ProfileAgent,
  accountId: string
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  try {
    for (const record of host.deps.store.listRecords()) {
      const profile = record.accountHome.agentProfile
      if (
        profile?.agent !== agent ||
        profile.binding.kind !== 'managed' ||
        profile.binding.accountId !== accountId
      ) {
        continue
      }
      if (
        record.lease.claimStatus === 'released' &&
        record.lease.ownerProcess === null &&
        !record.lease.unreconciled
      ) {
        continue
      }
      const probe = await host.deps.probeOwner?.(record)
      if (probe && (isProvenDeadProbe(probe) || probe.outcome === 'reservation-unused')) {
        continue
      }
      throw new Error('Close structured sessions using this profile before removing its account.')
    }
  } catch {
    throw new Error(
      'Structured profile ownership is live or uncertain. Close its sessions before removing the account.'
    )
  }
}
