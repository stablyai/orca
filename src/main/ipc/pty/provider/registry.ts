import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId, toAppSshPtyId, toRelaySshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from './ownership-state'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import { colorQueryReplyColorsEqual } from '../../../../shared/pty-owner-color-query-colors'
import {
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'

// ─── Provider Registry ──────────────────────────────────────────────
// Routes PTY operations by the execution host that runs the PTY; this machine is `local`.

export let localProvider: IPtyProvider = new LocalPtyProvider()
/** SSH relay providers by SSH target id; address them through their `ssh:` host id. */
export const sshProviders = new Map<string, IPtyProvider>()
export const sshProvidersByGeneration = new Map<number, IPtyProvider>()
let colorQueryReplyColors: TerminalOscColorQueryReplyColors | null = null

// Why push to every owner: each process that owns PTYs (in-process, daemon, relay) answers
// OSC 10/11 itself, so a theme change must reach it before its next query, not at spawn.
// Why never push "unknown": a daemon outlives the app and keeps the last run's theme.
function pushColorQueryReplyColors(provider: IPtyProvider): void {
  if (!colorQueryReplyColors) {
    return
  }
  try {
    provider.setColorQueryReplyColors?.(colorQueryReplyColors)
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
  for (const { provider } of registeredPtyProviders()) {
    pushColorQueryReplyColors(provider)
  }
}

export function _resetColorQueryReplyColorsForTest(): void {
  colorQueryReplyColors = null
}

export type RegisteredPtyProvider = {
  provider: IPtyProvider
  hostId: ExecutionHostId
}

export function registeredPtyProviders(): RegisteredPtyProvider[] {
  return [
    { provider: localProvider, hostId: LOCAL_EXECUTION_HOST_ID },
    ...Array.from(sshProviders, ([connectionId, provider]) => ({
      provider,
      hostId: toSshExecutionHostId(connectionId)
    }))
  ]
}

export class PtyHostNotDispatchableError extends Error {
  constructor(readonly hostId: ExecutionHostId | 'foreign') {
    // Why: a paired runtime drives its own PTYs over runtime RPC; this process has no provider for them.
    super(`PTY host "${hostId}" is not dispatchable from this process`)
    this.name = 'PtyHostNotDispatchableError'
  }
}

export function getProvider(hostId: ExecutionHostId): IPtyProvider {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return localProvider
  }
  const connectionId = getSshTargetIdForExecutionHost(hostId)
  if (connectionId === null) {
    throw new PtyHostNotDispatchableError(hostId)
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

/** The host that runs a PTY: its recorded owner, else the host its id names. 'foreign' = off this
 *  machine but unnameable. */
export function resolvePtyExecutionHost(ptyId: string): ExecutionHostId | 'foreign' {
  const owner = ptyOwnership.get(ptyId)
  if (owner !== undefined) {
    return owner
  }
  // Why: disconnected SSH PTYs retain their encoded owner and must never fall through to the HUB-local provider.
  const ssh = parseAppSshPtyId(ptyId)
  if (ssh) {
    return toSshExecutionHostId(ssh.connectionId)
  }
  // Why: local PTY ids are bare (daemon-restored ids arrive before any ownership is recorded), so
  // only an id that names no host may run here; `remote:` and malformed `ssh:` ids never do.
  return getPtyExecutionHost(ptyId) ?? LOCAL_EXECUTION_HOST_ID
}

/** The SSH target a PTY runs on, or null for any other host. */
export function getPtySshConnectionId(ptyId: string): string | null {
  const hostId = resolvePtyExecutionHost(ptyId)
  return hostId === 'foreign' ? null : getSshTargetIdForExecutionHost(hostId)
}

/** Whether this process can hold a provider for the host at all (this machine or an SSH relay). */
export function isDispatchablePtyHost(hostId: ExecutionHostId | 'foreign'): boolean {
  return (
    hostId === LOCAL_EXECUTION_HOST_ID ||
    (hostId !== 'foreign' && getSshTargetIdForExecutionHost(hostId) !== null)
  )
}

export function getProviderForPty(ptyId: string): IPtyProvider {
  const hostId = resolvePtyExecutionHost(ptyId)
  if (hostId === 'foreign') {
    throw new PtyHostNotDispatchableError(hostId)
  }
  return getProvider(hostId)
}

export function hasPtyProviderForInspection(ptyId: string): boolean {
  // Why: process inspection is background polling; disconnected SSH hosts should read as idle, not raise repeated IPC errors.
  if (resolvePtyExecutionHost(ptyId) === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  const connectionId = getPtySshConnectionId(ptyId)
  return connectionId !== null && sshProviders.has(connectionId)
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

/** Register an SSH PTY provider for a connection. */
export function registerSshPtyProvider(connectionId: string, provider: IPtyProvider): void {
  sshProviders.set(connectionId, provider)
  pushColorQueryReplyColors(provider)
  const generation = provider.providerGeneration
  if (generation !== undefined && Number.isSafeInteger(generation) && generation > 0) {
    sshProvidersByGeneration.set(generation, provider)
  }
}

/** Remove an SSH PTY provider when a connection is closed. */
export function unregisterSshPtyProvider(connectionId: string): void {
  const provider = sshProviders.get(connectionId)
  const generation = provider?.providerGeneration
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
  pushColorQueryReplyColors(provider)
}
