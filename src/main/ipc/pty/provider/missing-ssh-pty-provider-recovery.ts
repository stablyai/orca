import { recoverSshProviderMiss } from '../../../providers/ssh-provider-miss-recovery'
import { sshProviders } from './registry'

/**
 * A promise only when a recovery is installed, the connection has no PTY provider, and the
 * owner claims it. Spawn paths await this before `getProvider` so a runtime-owned target
 * whose relay is gone (app restart) is re-attached instead of failing on the miss.
 */
export function recoverMissingSshPtyProvider(
  connectionId: string | null | undefined
): Promise<void> | undefined {
  if (!connectionId || sshProviders.has(connectionId)) {
    return undefined
  }
  return recoverSshProviderMiss(connectionId)
}
