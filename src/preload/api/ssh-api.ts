import type {
  EnrichedDetectedPort,
  PortForwardEntry,
  SshConfigHostListArgs,
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshConfigImportResult,
  SshConnectionState,
  SshTarget,
  SshTargetAddResult
} from '../../shared/ssh-types'
import type { FilesystemPathFlavor } from '../../shared/filesystem-entry-types'

export type SshApi = {
  listTargets: () => Promise<SshTarget[]>
  // Removed-target id → last known label, for a friendly host name on workspaces still pinned to a removed target.
  listRemovedTargetLabels: () => Promise<Record<string, string>>
  addTarget: (args: { target: Omit<SshTarget, 'id'> }) => Promise<SshTargetAddResult>
  updateTarget: (args: {
    id: string
    updates: Partial<Omit<SshTarget, 'id'>>
  }) => Promise<SshTarget>
  removeTarget: (args: { id: string }) => Promise<void>
  importConfig: (args?: { reAdopt?: boolean }) => Promise<SshConfigImportResult>
  listConfigHosts: (args?: SshConfigHostListArgs) => Promise<SshConfigHostListResult>
  resolveConfigHost: (args: { alias: string }) => Promise<SshConfigHostResolution | null>
  connect: (args: { targetId: string }) => Promise<SshConnectionState | null>
  disconnect: (args: { targetId: string }) => Promise<void>
  terminateSessions: (args: { targetId: string }) => Promise<void>
  resetRelay: (args: { targetId: string }) => Promise<void>
  getState: (args: { targetId: string }) => Promise<SshConnectionState | null>
  needsPassphrasePrompt: (args: { targetId: string }) => Promise<boolean>
  testConnection: (args: {
    targetId: string
  }) => Promise<{ success: boolean; error?: string; state?: SshConnectionState }>
  onStateChanged: (
    callback: (data: { targetId: string; state: SshConnectionState }) => void
  ) => () => void
  addPortForward: (args: {
    targetId: string
    localPort: number
    remoteHost: string
    remotePort: number
    label?: string
  }) => Promise<PortForwardEntry>
  updatePortForward: (args: {
    id: string
    targetId: string
    localPort: number
    remoteHost: string
    remotePort: number
    label?: string
  }) => Promise<PortForwardEntry>
  removePortForward: (args: { id: string }) => Promise<PortForwardEntry | null>
  listPortForwards: (args?: { targetId?: string }) => Promise<PortForwardEntry[]>
  listDetectedPorts: (args: { targetId: string }) => Promise<EnrichedDetectedPort[]>
  onPortForwardsChanged: (
    callback: (data: { targetId: string; forwards: PortForwardEntry[] }) => void
  ) => () => void
  onDetectedPortsChanged: (
    callback: (data: { targetId: string; ports: EnrichedDetectedPort[] }) => void
  ) => () => void
  browseDir: (args: { targetId: string; dirPath: string }) => Promise<{
    entries: { name: string; isDirectory: boolean }[]
    resolvedPath: string
    pathFlavor: FilesystemPathFlavor
  }>
  onCredentialRequest: (
    callback: (data: {
      requestId: string
      targetId: string
      kind: 'passphrase' | 'password'
      detail: string
    }) => void
  ) => () => void
  onCredentialResolved: (callback: (data: { requestId: string }) => void) => () => void
  submitCredential: (args: { requestId: string; value: string | null }) => Promise<void>
}
