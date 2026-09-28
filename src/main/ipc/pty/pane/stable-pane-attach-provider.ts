import type { IPtyProvider } from '../../../providers/types'
import { getProviderForPty, tryGetProviderForPty } from '../provider/registry'

/** A late guest owner overrides the fresh-spawn provider and fences asynchronous replies. */
export function stablePaneAttachProvider(id: string, freshProvider: IPtyProvider) {
  const guestOwner = id.startsWith('wsl:')
  const provider = guestOwner ? getProviderForPty(id) : freshProvider
  return {
    provider,
    assertOwnerConnected() {
      if (guestOwner && tryGetProviderForPty(id) !== provider) {
        throw new Error('WSL terminal owner changed during attach')
      }
    }
  }
}
