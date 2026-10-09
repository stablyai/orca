import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from './ownership-state'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import {
  colorQueryReplyColorsEqual,
  repoColorQueryReplyColorsByHostEqual,
  repoColorQueryReplyColorsEqual,
  type PtyOwnerRepoColors,
  type PtyOwnerRepoColorsByHost
} from '../../../../shared/pty-owner-color-query-colors'
import { getConnectionTerminalThemeHostId } from '../../../../shared/terminal-theme-execution-host'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by connectionId (null = local provider).

export let localProvider: IPtyProvider = new LocalPtyProvider()
export const sshProviders = new Map<string, IPtyProvider>()
export const sshProvidersByGeneration = new Map<number, IPtyProvider>()
let colorQueryReplyColors: TerminalOscColorQueryReplyColors | null = null
// Null until the renderer's first project-theme push (or main's seed), which covers every host.
let repoColorQueryReplyColorsByHost: PtyOwnerRepoColorsByHost | null = null

const NO_THEMED_PROJECTS: PtyOwnerRepoColors = {}

/** The slice of the project map one owner is told: its own host's entries (repo ids are
 *  unambiguous within a host), empty once main knows no project there is themed, and nothing at
 *  all while main knows no map (the owner then keeps its last one). */
function repoColorQueryReplyColorsForOwner(connectionId: string | null): PtyOwnerRepoColors | null {
  if (!repoColorQueryReplyColorsByHost) {
    return null
  }
  return (
    repoColorQueryReplyColorsByHost[getConnectionTerminalThemeHostId(connectionId)] ??
    NO_THEMED_PROJECTS
  )
}

// Why push to every owner: each process that owns PTYs (in-process, daemon, relay) answers
// OSC 10/11 itself, so a theme change must reach it before its next query, not at spawn.
// Why never push "unknown": a daemon outlives the app and keeps the last run's theme.
function pushColorQueryReplyColors({ provider, connectionId }: RegisteredPtyProvider): void {
  if (!colorQueryReplyColors) {
    return
  }
  try {
    const byRepoId = repoColorQueryReplyColorsForOwner(connectionId)
    if (byRepoId) {
      provider.setColorQueryReplyColors?.(colorQueryReplyColors, byRepoId)
    } else {
      provider.setColorQueryReplyColors?.(colorQueryReplyColors)
    }
  } catch {
    /* Best-effort; the owner keeps answering from its last or default colours. */
  }
}

export function publishColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
  // Why: a re-install republishes unchanged colours; that must not re-notify every daemon and relay.
  if (colorQueryReplyColorsEqual(colorQueryReplyColors, colors)) {
    return
  }
  colorQueryReplyColors = colors
  for (const registered of registeredPtyProviders()) {
    pushColorQueryReplyColors(registered)
  }
}

/** Project colours by execution host, then repo id; each owner hears only its own host's. */
export function publishRepoColorQueryReplyColors(byHost: PtyOwnerRepoColorsByHost): void {
  const previous = repoColorQueryReplyColorsByHost
  if (previous && repoColorQueryReplyColorsByHostEqual(previous, byHost)) {
    return
  }
  repoColorQueryReplyColorsByHost = byHost
  for (const registered of registeredPtyProviders()) {
    // Why per host: a change to another host's projects is not a change this owner can see.
    const hostId = getConnectionTerminalThemeHostId(registered.connectionId)
    if (
      !previous ||
      !repoColorQueryReplyColorsEqual(
        previous[hostId] ?? NO_THEMED_PROJECTS,
        byHost[hostId] ?? NO_THEMED_PROJECTS
      )
    ) {
      pushColorQueryReplyColors(registered)
    }
  }
}

export function _resetColorQueryReplyColorsForTest(): void {
  colorQueryReplyColors = null
  repoColorQueryReplyColorsByHost = null
}

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
    // Why the suffix: this surfaces verbatim in `terminal create` on a reconnecting SSH host; the
    // bare id told the caller nothing about what to do. Keep the prefix — the renderer matches it.
    throw new Error(
      `No PTY provider for connection "${connectionId}": the SSH relay for this host is not attached ` +
        '(reconnecting or disconnected). Wait for the host to reconnect, or use Reconnect on the SSH target.'
    )
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
  // Why on every registration: a reconnect brings a fresh relay channel that must hear this
  // host's colours and project map again.
  pushColorQueryReplyColors({ provider, connectionId })
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
  pushColorQueryReplyColors({ provider, connectionId: null })
}
