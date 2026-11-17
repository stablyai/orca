import type { SshConnectionStore } from './ssh-connection-store'
import type { SshConnectionManager } from '../connection/ssh-connection-manager'
import type { SshPortForwardManager } from '../port-forwarding/ssh-port-forward'
import type {
  SshConnectionState,
  SshTarget,
  SshConfigImportResult,
  SshTargetAddResult,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../../shared/remote-runtime/ssh/ssh-types'

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
let registeredDisconnectSshTarget: ((targetId: string) => Promise<void>) | null = null

export function setSshTargetRegistryStore(store: SshConnectionStore | null): void {
  sshStore = store
}

export function getSshTargetRegistryStore(): SshConnectionStore | null {
  return sshStore
}

const sshTestProbeTargets = new Set<string>()

export function markSshTestProbe(targetId: string): void {
  sshTestProbeTargets.add(targetId)
}

export function unmarkSshTestProbe(targetId: string): void {
  sshTestProbeTargets.delete(targetId)
}

export function isSshTestProbe(targetId: string): boolean {
  return sshTestProbeTargets.has(targetId)
}

/** SSH config aliases explicitly removed by the user; passive imports must keep them suppressed. */
export function listRegisteredSuppressedSshConfigAliases(): string[] {
  return sshStore?.listSuppressedSshConfigAliases() ?? []
}

/** Import the host-owned OpenSSH config without exposing the profile store to RPC code. */
export function importRegisteredSshConfig(options?: { reAdopt?: boolean }): SshConfigImportResult {
  if (!sshStore) {
    throw new Error('ssh_handlers_not_registered')
  }
  const targets = sshStore.importFromSshConfig(options)
  const repoReadoptions = sshStore.lastRepoReadoptions
  sshStore.lastRepoReadoptions = []
  return { targets, repoReadoptions }
}

export function setSshTargetRegistryHandlers(handlers: {
  connect: ConnectSshTarget | null
  getState: ((targetId: string) => SshConnectionState | undefined) | null
  disconnect?: ((targetId: string) => Promise<void>) | null
}): void {
  registeredConnectSshTarget = handlers.connect
  registeredGetSshState = handlers.getState
  registeredDisconnectSshTarget = handlers.disconnect ?? null
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

export async function disconnectRegisteredSshTarget(targetId: string): Promise<void> {
  if (!registeredDisconnectSshTarget) {
    throw new Error('ssh_handlers_not_registered')
  }
  await registeredDisconnectSshTarget(targetId)
}

/** Public targets for runtime RPC clients — same list the desktop renderer gets. */
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

let registeredGetSshPortForwardManager: (() => SshPortForwardManager | null) | null = null

export function setSshPortForwardManagerResolver(
  resolve: (() => SshPortForwardManager | null) | null
): void {
  registeredGetSshPortForwardManager = resolve
}

export function getSshPortForwardManager(): SshPortForwardManager | null {
  return registeredGetSshPortForwardManager?.() ?? null
}
