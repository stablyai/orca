import type { SshConnectionStore } from '../connection/ssh-connection-store'
import type { SshConnectionManager } from '../connection/ssh-connection-manager'
import type {
  SshConnectionState,
  SshTarget,
  SshTargetAddResult,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../../shared/ssh-types'

/** Keep runtime SSH access free of Electron imports from ipc/ssh.ts. Resolve callbacks on each call because handler registration may replace the manager. */

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
    // No SSH stack must report unserved, never masquerade as an unreachable/exited target.
    throw new SshTargetManagementUnservedError()
  }
  return registeredConnectSshTarget(targetId, options)
}

export function getRegisteredSshState(targetId: string): SshConnectionState | undefined {
  return registeredGetSshState?.(targetId)
}

/** Same public target projection as the desktop renderer. */
export function listRegisteredSshTargets(): SshTarget[] {
  return sshStore?.listTargets() ?? []
}

/** Removed-target id → last known label, for ghost-host display on paired clients. */
export function listRegisteredRemovedSshTargetLabels(): Record<string, string> {
  return sshStore?.listRemovedTargetLabels() ?? {}
}

type SshTargetMutations = {
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

/** Null means no registered SSH stack, never a connection exit (docs/reference/ssh-execution-boundary.md). Resolve each call because handlers may replace the manager. */
export function getSshConnectionManager(): SshConnectionManager | null {
  return registeredGetSshConnectionManager?.() ?? null
}
