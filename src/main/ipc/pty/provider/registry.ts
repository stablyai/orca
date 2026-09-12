import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from './ownership-state'
import { assertPtyRouteAdmissionAllowed } from './pty-route-refusal'
import { getDelegatedPtyProvider, hasDelegatedPtyProviderRoute } from './delegated-provider-routes'
import {
  snapshotDelegatedPtyProviderRoutes,
  delegatedPtyProviderRoutesRevision
} from './delegated-provider-routes'
import type { PtyOwnershipTransferWireIdentity } from '../../../../shared/pty-ownership-transfer-wire'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId (null = local provider).

export let localProvider: IPtyProvider = new LocalPtyProvider()
export const sshProviders = new Map<string, IPtyProvider>()
export const sshProvidersByGeneration = new Map<number, IPtyProvider>()
const localProviderChangeListeners = new Set<(provider: IPtyProvider) => void>()

export type RegisteredPtyProvider = {
  provider: IPtyProvider | undefined
  connectionId: string | null
  delegatedIdentity?: PtyOwnershipTransferWireIdentity
  isCurrent?: () => boolean
}

export function registeredPtyProviders(): RegisteredPtyProvider[] {
  const revision = delegatedPtyProviderRoutesRevision()
  const nativeProvider = localProvider
  return [
    {
      provider: nativeProvider,
      connectionId: null,
      isCurrent: () =>
        localProvider === nativeProvider && delegatedPtyProviderRoutesRevision() === revision
    },
    ...Array.from(sshProviders, ([connectionId, provider]) => ({ provider, connectionId })),
    ...snapshotDelegatedPtyProviderRoutes().map(({ identity, provider, isCurrent }) => ({
      provider,
      connectionId: null,
      delegatedIdentity: identity,
      isCurrent
    }))
  ]
}

export function getProvider(connectionId: string | null | undefined): IPtyProvider {
  if (!connectionId) {
    return localProvider
  }
  const provider = sshProviders.get(connectionId)
  if (!provider) {
    throw new Error(
      `No PTY provider for connection "${connectionId}": the SSH relay for this host is not attached ` +
        '(reconnecting or disconnected). Wait for the host to reconnect, or use Reconnect on the SSH target.'
    )
  }
  return provider
}

export function getProviderForPty(ptyId: string): IPtyProvider {
  assertPtyRouteAdmissionAllowed(ptyId)
  const delegated = getDelegatedPtyProvider(ptyId)
  if (delegated) {
    return delegated
  }
  const connectionId = ptyOwnership.get(ptyId)
  if (connectionId === undefined) {
    const parsedSshId = parseAppSshPtyId(ptyId)
    if (parsedSshId) {
      // Why: disconnected SSH PTYs retain their encoded owner and must never fall through to the HUB-local provider.
      return requirePtyControlRoute(getProvider(parsedSshId.connectionId), ptyId)
    }
    return localProvider
  }
  return requirePtyControlRoute(getProvider(connectionId), ptyId)
}

function requirePtyControlRoute(provider: IPtyProvider, ptyId: string): IPtyProvider {
  if (provider.isOutgoingSourceControlReleased?.(ptyId)) {
    throw new Error('orcad_outgoing_source_control_released')
  }
  return provider
}

export function hasPtyProviderForInspection(ptyId: string): boolean {
  if (hasDelegatedPtyProviderRoute(ptyId)) {
    return tryGetProviderForPty(ptyId) !== undefined
  }
  // Why: process inspection is background polling; disconnected SSH hosts should read as idle, not raise repeated IPC errors.
  const connectionId = ptyOwnership.get(ptyId)
  if (connectionId === undefined) {
    // Why: mirror getProviderForPty — an unowned id still routes by its encoded SSH owner.
    const parsedSshId = parseAppSshPtyId(ptyId)
    return !parsedSshId || tryGetProviderForPty(ptyId) !== undefined
  }
  return connectionId === null || tryGetProviderForPty(ptyId) !== undefined
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
  return tryGetProviderForPty(ptyId)
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

/** Registry-only CAS; caller must prove that retiring the entire target registration is authorized. */
export function unregisterSshPtyProviderIfCurrent(
  connectionId: string,
  expectedProvider: IPtyProvider,
  expectedGeneration: number
): boolean {
  if (
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration <= 0 ||
    sshProviders.get(connectionId) !== expectedProvider ||
    (expectedProvider as { providerGeneration?: number }).providerGeneration !==
      expectedGeneration ||
    sshProvidersByGeneration.get(expectedGeneration) !== expectedProvider
  ) {
    return false
  }
  sshProvidersByGeneration.delete(expectedGeneration)
  sshProviders.delete(connectionId)
  return true
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

export function subscribeLocalPtyProviderChanges(
  listener: (provider: IPtyProvider) => void
): () => void {
  localProviderChangeListeners.add(listener)
  return () => localProviderChangeListeners.delete(listener)
}

/** Replace the local PTY provider with a daemon-backed one.
 *  Call before registerPtyHandlers so the IPC layer routes through the daemon. */
export function setLocalPtyProvider(provider: IPtyProvider): void {
  localProvider = provider
  for (const listener of localProviderChangeListeners) {
    try {
      listener(provider)
    } catch (error) {
      console.warn('[pty-provider] local provider change listener failed:', error)
    }
  }
}
