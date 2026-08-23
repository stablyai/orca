import type { SshConnectionStore } from './ssh-connection-store'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'

/**
 * The SSH target/state registry, split out of `ipc/ssh.ts`.
 *
 * Why: the Orca runtime reads registered SSH targets and state during normal
 * operation, but `ipc/ssh.ts` also owns `ipcMain`, `powerMonitor` and a
 * `BrowserWindow` accessor. Importing four thin accessors dragged all of Electron
 * into the runtime's module graph.
 *
 * This holds only the registry: the store plus the two callbacks the handler layer
 * installs. `registerSshHandlers` populates it; the runtime reads it. Keeping the
 * indirection (rather than the runtime holding a manager directly) is deliberate —
 * SSH providers register after construction and may reconnect, so callers must
 * resolve the current generation rather than freeze one.
 */

let sshStore: SshConnectionStore | null = null
let registeredConnectSshTarget: ((targetId: string) => Promise<SshConnectionState>) | null = null
let registeredGetSshState: ((targetId: string) => SshConnectionState | undefined) | null = null

export function setSshTargetRegistryStore(store: SshConnectionStore | null): void {
  sshStore = store
}

export function getSshTargetRegistryStore(): SshConnectionStore | null {
  return sshStore
}

export function setSshTargetRegistryHandlers(handlers: {
  connect: ((targetId: string) => Promise<SshConnectionState>) | null
  getState: ((targetId: string) => SshConnectionState | undefined) | null
}): void {
  registeredConnectSshTarget = handlers.connect
  registeredGetSshState = handlers.getState
}

export async function connectRegisteredSshTarget(targetId: string): Promise<SshConnectionState> {
  if (!registeredConnectSshTarget) {
    // Why this still throws: a headless host that never registered handlers must fail
    // loudly rather than report a target as unreachable, which would read as `exited`.
    throw new Error('ssh_handlers_not_registered')
  }
  return registeredConnectSshTarget(targetId)
}

export function getRegisteredSshState(targetId: string): SshConnectionState | undefined {
  return registeredGetSshState?.(targetId)
}

/** Public targets for runtime RPC clients — same list the desktop renderer gets. */
export function listRegisteredSshTargets(): SshTarget[] {
  return sshStore?.listTargets() ?? []
}

/** Removed-target id → last known label, for ghost-host display on paired clients. */
export function listRegisteredRemovedSshTargetLabels(): Record<string, string> {
  return sshStore?.listRemovedTargetLabels() ?? {}
}

let registeredGetActiveMultiplexer:
  | ((connectionId: string) => SshChannelMultiplexer | undefined)
  | null = null

export function setSshActiveMultiplexerResolver(
  resolve: ((connectionId: string) => SshChannelMultiplexer | undefined) | null
): void {
  registeredGetActiveMultiplexer = resolve
}

/**
 * The live channel multiplexer for a connection, or undefined when the target is not
 * connected. Undefined means "not connected", never "the connection died" — callers
 * must not read absence here as an `exited` verdict (docs/reference/ssh-execution-boundary.md).
 *
 * Why it throws when no resolver is installed rather than returning undefined: that
 * case is a wiring error, not a connection state, and the two are indistinguishable to
 * callers. A host that never loaded the SSH layer would otherwise report every target as
 * quietly "not connected" — which is precisely the unverifiable-reported-as-exited
 * conflation the execution-boundary doc exists to prevent.
 */
export function getActiveMultiplexer(connectionId: string): SshChannelMultiplexer | undefined {
  if (!registeredGetActiveMultiplexer) {
    throw new Error('ssh_active_multiplexer_resolver_not_installed')
  }
  return registeredGetActiveMultiplexer(connectionId)
}
