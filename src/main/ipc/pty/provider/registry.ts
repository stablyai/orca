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

export let localProvider: IPtyProvider = new LocalPtyProvider()
let colorQueryReplyColors: TerminalOscColorQueryReplyColors | null = null

// Push theme updates to every PTY owner before its next OSC query; never erase a surviving daemon's theme with unknown.
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
  // Preserve this renderer-matched reconnect error prefix.
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
  // Disconnected SSH IDs retain their host and must never reach local fallback.
  const ssh = parseAppSshPtyId(ptyId)
  if (ssh) {
    return toSshExecutionHostId(ssh.connectionId)
  }
  // Bare restored IDs may be local before ownership hydration; encoded remote/malformed SSH IDs may not.
  return getPtyExecutionHost(ptyId) ?? LOCAL_EXECUTION_HOST_ID
}

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

/** Daemon startup can replace LocalPtyProvider; narrow before using in-process-only methods. */
export function getLocalPtyProvider(): IPtyProvider {
  return localProvider
}

/** Install before handler registration so PTY operations use the new provider. */
export function setLocalPtyProvider(provider: IPtyProvider): void {
  localProvider = provider
  pushColorQueryReplyColors(provider)
}
