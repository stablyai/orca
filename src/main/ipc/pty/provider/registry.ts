import { parseAppWslPtyId, type WslPtyOwner } from '../../../../shared/wsl-pty-id'
import { wslPtyOwnerKey } from '../../../../shared/wsl-pty-consumer-recovery'
import { relayProvidersByGeneration } from '../../../providers/relay-pty-generation-registry'
import { createUnavailablePtyProvider } from '../../../providers/unavailable-pty-provider'
import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from './ownership-state'
import { rebindLocalProviderListeners } from './listener-lifecycle'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId (null = local provider).

export let localProvider: IPtyProvider = createUnavailablePtyProvider()
export const sshProviders = new Map<string, IPtyProvider>()
const wslProviders = new Map<string, IPtyProvider>()

export type RegisteredPtyProvider = {
  provider: IPtyProvider
  connectionId: string | null
}

export function registeredPtyProviders(): RegisteredPtyProvider[] {
  return [
    { provider: localProvider, connectionId: null },
    ...Array.from(sshProviders, ([connectionId, provider]) => ({ provider, connectionId })),
    ...Array.from(wslProviders.values(), (provider) => ({ provider, connectionId: null }))
  ]
}

export function getProvider(connectionId: string | null | undefined): IPtyProvider {
  if (!connectionId) {
    return localProvider
  }
  const provider = sshProviders.get(connectionId)
  if (!provider) {
    // Why the suffix: this surfaces verbatim in `terminal create` on a reconnecting SSH host; the
    // bare id told the caller nothing about what to do. Keep the prefix — the renderer matches it.
    throw new Error(
      `No PTY provider for connection "${connectionId}": the SSH relay for this host is not attached ` +
        '(reconnecting or disconnected). Wait for the host to reconnect, or use Reconnect on the SSH target.'
    )
  }
  return provider
}

export function registerWslPtyProvider(owner: WslPtyOwner, provider: IPtyProvider): () => void {
  const key = wslPtyOwnerKey(owner)
  const previous = wslProviders.get(key)
  if (previous && previous !== provider) {
    throw new Error('WSL terminal owner already registered')
  }
  wslProviders.set(key, provider)
  rebindLocalProviderListeners()
  return () => {
    if (wslProviders.get(key) === provider) {
      wslProviders.delete(key)
      rebindLocalProviderListeners()
    }
  }
}

export function getProviderForPty(ptyId: string): IPtyProvider {
  const wslOwner = parseAppWslPtyId(ptyId)
  if (wslOwner) {
    const provider = wslProviders.get(wslPtyOwnerKey(wslOwner))
    if (!provider) {
      throw new Error('WSL terminal owner is not connected; reconnect its owning distro')
    }
    return provider
  }
  if (ptyId.startsWith('wsl:')) {
    throw new Error('Invalid WSL terminal identity')
  }
  const connectionId = ptyOwnership.get(ptyId)
  if (connectionId === undefined) {
    const parsedSshId = parseAppSshPtyId(ptyId)
    if (parsedSshId) {
      // Why: disconnected SSH PTYs retain their encoded owner and must never fall through to the HUB-local provider.
      return getProvider(parsedSshId.connectionId)
    }
    return localProvider
  }
  return getProvider(connectionId)
}

export function hasPtyProviderForInspection(ptyId: string): boolean {
  const wslOwner = parseAppWslPtyId(ptyId)
  if (wslOwner) {
    return wslProviders.has(wslPtyOwnerKey(wslOwner))
  }
  if (ptyId.startsWith('wsl:')) {
    return false
  }
  // Why: process inspection is background polling; disconnected SSH hosts should read as idle, not raise repeated IPC errors.
  const connectionId = ptyOwnership.get(ptyId)
  if (connectionId === undefined) {
    // Why: mirror getProviderForPty — an unowned id still routes by its encoded SSH owner.
    const parsedSshId = parseAppSshPtyId(ptyId)
    return !parsedSshId || sshProviders.has(parsedSshId.connectionId)
  }
  return connectionId === null || sshProviders.has(connectionId)
}

export function getAppPtyId(connectionId: string | null | undefined, ptyId: string): string {
  return connectionId ? toAppSshPtyId(connectionId, ptyId) : ptyId
}

export function getRelayPtyId(connectionId: string | null | undefined, ptyId: string): string {
  return connectionId ? toRelaySshPtyId(connectionId, ptyId) : ptyId
}

export function tryGetProviderForPty(ptyId: string): IPtyProvider | undefined {
  try {
    return getProviderForPty(ptyId)
  } catch {
    return undefined
  }
}

export function closeStartupQueryAuthorityForPty(ptyId: string): void {
  try {
    void Promise.resolve(tryGetProviderForPty(ptyId)?.closeStartupQueryAuthority?.(ptyId)).catch(
      () => {}
    )
  } catch {
    /* Best-effort handoff; the bounded source deadline remains the fallback. */
  }
}

export function tryGetProviderForAgentSessionOwner(ptyId: string): IPtyProvider | undefined {
  if (ptyId.startsWith('wsl:')) {
    return tryGetProviderForPty(ptyId)
  }
  const ownedConnectionId = ptyOwnership.get(ptyId)
  const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(ptyId) : null
  try {
    return getProvider(parsedSshId?.connectionId ?? ownedConnectionId)
  } catch {
    return undefined
  }
}

/** Register an SSH PTY provider for a connection. */
export function registerSshPtyProvider(connectionId: string, provider: IPtyProvider): void {
  sshProviders.set(connectionId, provider)
  const generation = (provider as { providerGeneration?: number }).providerGeneration
  if (Number.isSafeInteger(generation) && generation! > 0) {
    relayProvidersByGeneration.set(generation!, provider)
  }
}

/** Remove an SSH PTY provider when a connection is closed. */
export function unregisterSshPtyProvider(connectionId: string): void {
  const provider = sshProviders.get(connectionId)
  const generation = (provider as { providerGeneration?: number } | undefined)?.providerGeneration
  if (generation !== undefined && relayProvidersByGeneration.get(generation) === provider) {
    relayProvidersByGeneration.delete(generation)
  }
  sshProviders.delete(connectionId)
}

/** Get the SSH PTY provider for a connection (for dispose on cleanup). */
export function getSshPtyProvider(connectionId: string): IPtyProvider | undefined {
  return sshProviders.get(connectionId)
}

/** Get the installed daemon provider for runtime operations and tests. */
export function getLocalPtyProvider(): IPtyProvider {
  return localProvider
}

/** Replace the local PTY provider with a daemon-backed one.
 *  Call before registerPtyHandlers so the IPC layer routes through the daemon. */
export function setLocalPtyProvider(provider: IPtyProvider): void {
  localProvider = provider
}
