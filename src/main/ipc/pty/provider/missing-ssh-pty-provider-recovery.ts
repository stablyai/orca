import { sshProviders } from './registry'

type MissingSshPtyProviderRecovery = (connectionId: string) => Promise<void> | undefined

let recovery: MissingSshPtyProviderRecovery | null = null

/**
 * Installed by the layer that owns a connection's relay health (today: the ephemeral-VM
 * runtime for runtime-owned targets). Consulted only when a PTY operation arrives for an
 * SSH connection with no registered provider, so the owner can re-attach the relay
 * instead of the lookup failing on the miss. Which targets to dial is the owner's policy.
 */
export function setMissingSshPtyProviderRecovery(next: MissingSshPtyProviderRecovery | null): void {
  recovery = next
}

/** A promise only when a recovery is installed and the connection has no PTY provider. */
export function recoverMissingSshPtyProvider(
  connectionId: string | null | undefined
): Promise<void> | undefined {
  if (!connectionId || !recovery || sshProviders.has(connectionId)) {
    return undefined
  }
  return recovery(connectionId)
}
