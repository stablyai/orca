import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from './ownership-state'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId (null = local provider).

export let localProvider: IPtyProvider = new LocalPtyProvider()
export const sshProviders = new Map<string, IPtyProvider>()
export const sshProvidersByGeneration = new Map<number, IPtyProvider>()

export type RegisteredPtyProvider = {
  provider: IPtyProvider
  connectionId: string | null
}

export function registeredPtyProviders(): RegisteredPtyProvider[] {
  return [
    { provider: localProvider, connectionId: null },
    ...Array.from(sshProviders, ([connectionId, provider]) => ({ provider, connectionId }))
  ]
}

export function getProvider(connectionId: string | null | undefined): IPtyProvider {
  if (!connectionId) {
    return localProvider
  }
  const provider = sshProviders.get(connectionId)
  if (!provider) {
    throw new Error(`No PTY provider for connection "${connectionId}"`)
  }
  return provider
}

export function getProviderForPty(ptyId: string): IPtyProvider {
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
    sshProvidersByGeneration.set(generation!, provider)
  }
}

/** Remove an SSH PTY provider when a connection is closed. */
export function unregisterSshPtyProvider(connectionId: string): void {
  const provider = sshProviders.get(connectionId)
  const generation = (provider as { providerGeneration?: number } | undefined)?.providerGeneration
  if (generation !== undefined && sshProvidersByGeneration.get(generation) === provider) {
    sshProvidersByGeneration.delete(generation)
  }
  sshProviders.delete(connectionId)
}

/** Get the SSH PTY provider for a connection (for dispose on cleanup). */
export function getSshPtyProvider(connectionId: string): IPtyProvider | undefined {
  return sshProviders.get(connectionId)
}

/** Get the installed PTY provider (for direct access in tests/runtime).
 *  After daemon init this may be a DaemonPtyAdapter/DaemonPtyRouter, not LocalPtyProvider;
 *  callers needing LocalPtyProvider-specific methods must type-narrow or import the class. */
export function getLocalPtyProvider(): IPtyProvider {
  return localProvider
}

/** Replace the local PTY provider with a daemon-backed one.
 *  Call before registerPtyHandlers so the IPC layer routes through the daemon. */
export function setLocalPtyProvider(provider: IPtyProvider): void {
  localProvider = provider
}
