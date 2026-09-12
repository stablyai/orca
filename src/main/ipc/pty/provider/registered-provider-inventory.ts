import type { RegisteredPtyProvider } from './registry'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { hasDelegatedPtyProviderRoute } from './delegated-provider-routes'

export function assertRegisteredPtyInventoryCurrent(
  entries: readonly RegisteredPtyProvider[]
): void {
  if (entries.some((entry) => entry.isCurrent?.() === false)) {
    throw new Error('delegated_pty_inventory_superseded')
  }
}

export async function readRegisteredPtyProviderInventory(
  entry: RegisteredPtyProvider,
  options?: Parameters<IPtyProvider['listProcesses']>[0]
) {
  const { provider, delegatedIdentity: identity } = entry
  if (!provider || entry.isCurrent?.() === false) {
    throw new Error('delegated_pty_inventory_unverifiable')
  }
  const sessions = await (options === undefined
    ? provider.listProcesses()
    : provider.listProcesses(options))
  if (entry.isCurrent?.() === false) {
    throw new Error('delegated_pty_inventory_superseded')
  }
  if (identity) {
    if (
      sessions.length !== 1 ||
      sessions[0].id !== identity.terminalId ||
      sessions[0].incarnationId !== identity.incarnationId
    ) {
      throw new Error('delegated_pty_inventory_identity_mismatch')
    }
    return sessions
  }
  // The native daemon may retain the old row after transfer; it no longer owns that ID.
  return entry.connectionId === null
    ? sessions.filter((session) => !hasDelegatedPtyProviderRoute(session.id))
    : sessions
}
