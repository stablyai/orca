import type { SshConnectionStore } from '../connection/ssh-connection-store'
import type { SshConnectionManager } from '../connection/ssh-connection-manager'
import type {
  SshConnectionState,
  SshTarget,
  SshTargetAddResult,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../../shared/ssh-types'

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
 * `registerSshHandlers` may re-run, so callers must resolve the current generation
 * rather than freeze one.
 */

/** orcad has no SSH stack yet still advertises ssh.target-management.v1 (D3), so clients show this. */
export const SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE =
  "This Orca server runs without the desktop app, so it can't manage SSH hosts yet."

export class SshTargetManagementUnservedError extends Error {
  constructor() {
    super(SSH_TARGET_MANAGEMENT_UNSERVED_MESSAGE)
    this.name = 'SshTargetManagementUnservedError'
  }
}

let sshStore: SshConnectionStore | null = null
type ConnectSshTarget = (
  targetId: string,
  options?: { automatic?: boolean }
) => Promise<SshConnectionState>

let registeredConnectSshTarget: ConnectSshTarget | null = null
let registeredGetSshState: ((targetId: string) => SshConnectionState | undefined) | null = null

export function setSshTargetRegistryStore(store: SshConnectionStore | null): void {
  sshStore = store
}

export function getSshTargetRegistryStore(): SshConnectionStore | null {
  return sshStore
}

export function setSshTargetRegistryHandlers(handlers: {
  connect: ConnectSshTarget | null
  getState: ((targetId: string) => SshConnectionState | undefined) | null
}): void {
  registeredConnectSshTarget = handlers.connect
  registeredGetSshState = handlers.getState
}

/** `automatic`: no user asked for this connect, so a cancelled sign-in stays cancelled. */
export async function connectRegisteredSshTarget(
  targetId: string,
  options?: { automatic?: boolean }
): Promise<SshConnectionState> {
  if (!registeredConnectSshTarget) {
    // Why this still throws: a headless host that never registered handlers must fail
    // loudly rather than report a target as unreachable, which would read as `exited`.
    throw new SshTargetManagementUnservedError()
  }
  return registeredConnectSshTarget(targetId, options)
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

/** Add/update/remove with the same rules the desktop's SSH settings use. */
export type SshTargetMutations = {
  add: (target: SshTargetCreateInput) => SshTargetAddResult
  update: (targetId: string, updates: SshTargetUpdateInput) => SshTarget | null
  remove: (targetId: string) => Promise<void>
}

let registeredSshTargetMutations: SshTargetMutations | null = null

export function setSshTargetMutations(mutations: SshTargetMutations | null): void {
  registeredSshTargetMutations = mutations
}

export function getRegisteredSshTargetMutations(): SshTargetMutations {
  if (!registeredSshTargetMutations) {
    throw new SshTargetManagementUnservedError()
  }
  return registeredSshTargetMutations
}

let registeredGetSshConnectionManager: (() => SshConnectionManager | null) | null = null

export function setSshConnectionManagerResolver(
  resolve: (() => SshConnectionManager | null) | null
): void {
  registeredGetSshConnectionManager = resolve
}

/**
 * The live SSH connection manager, or null when the handler layer has not registered
 * one. Null means "this host has no SSH stack", never "the connection died" — callers
 * must not read absence as an `exited` verdict (docs/reference/ssh-execution-boundary.md).
 *
 * Why a resolver rather than the manager itself: `registerSshHandlers` may re-run and
 * replace the instance, so callers must resolve the current generation.
 */
export function getSshConnectionManager(): SshConnectionManager | null {
  return registeredGetSshConnectionManager?.() ?? null
}
