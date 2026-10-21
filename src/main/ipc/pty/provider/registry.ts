import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
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
let colorQueryReplyColors: TerminalOscColorQueryReplyColors | null = null

// Why push to every owner: each process that owns PTYs (in-process or daemon) answers
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
  // Why: a re-install republishes unchanged colours; that must not re-notify every daemon.
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
  return [{ provider: localProvider, hostId: LOCAL_EXECUTION_HOST_ID }]
}

function ptyHostNotDispatchableMessage(hostId: ResolvedPtyHost): string {
  const connectionId = hostId === 'foreign' ? null : getSshTargetIdForExecutionHost(hostId)
  if (connectionId === null) {
    return `PTY host "${hostId}" is not dispatchable from this process`
  }
  // Why: this surfaces verbatim in `terminal create`; keep the prefix — the renderer matches it.
  return (
    `No PTY provider for connection "${connectionId}": the SSH relay for this host is not attached ` +
    '(reconnecting or disconnected). Wait for the host to reconnect, or use Reconnect on the SSH target.'
  )
}

/** Only this machine's PTYs are driven here; a paired runtime drives its own over runtime RPC. */
export class PtyHostNotDispatchableError extends Error {
  constructor(readonly hostId: ResolvedPtyHost) {
    super(ptyHostNotDispatchableMessage(hostId))
    this.name = 'PtyHostNotDispatchableError'
  }
}

export function getProvider(hostId: ExecutionHostId): IPtyProvider {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return localProvider
  }
  throw new PtyHostNotDispatchableError(hostId)
}

/** 'foreign' = a PTY that runs off this machine on a host its id cannot name. */
export type ResolvedPtyHost = ExecutionHostId | 'foreign'

/** The host that runs a PTY: its recorded owner, else the host its id names. */
export function resolvePtyExecutionHost(ptyId: string): ResolvedPtyHost {
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

/** This machine, or an SSH host whose PTYs read as retryable rather than definitively foreign. */
export function isDispatchablePtyHost(hostId: ResolvedPtyHost): boolean {
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
  // Why: process inspection is background polling; other hosts read as idle, not repeated IPC errors.
  return resolvePtyExecutionHost(ptyId) === LOCAL_EXECUTION_HOST_ID
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
