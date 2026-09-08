// src/renderer/src/store/slices/ssh-slice-types.ts
// Domain type definitions for the SSH store slice — split out of ssh.ts to
// keep that file under oxlint's max-lines budget. Pure types only, no
// dependency on the slice's `set`/`get`; re-exported from ssh.ts so existing
// `from '.../slices/ssh'` imports keep working unchanged.

export type RemoteWorkspaceSyncStatus = {
  phase: 'idle' | 'pulling' | 'pushing' | 'synced' | 'conflict' | 'error' | 'offline'
  direction?: 'pull' | 'push'
  revision?: number
  updatedAt?: number
  lastSyncedAt?: number
  message?: string
}

// ─── Fleet Import Types (CR-001) ──────────────────────────────────────────────

export type FleetImportPhase = 'idle' | 'reading' | 'validating' | 'importing' | 'done' | 'error'

export type FleetImportStatus = {
  phase: FleetImportPhase
  /** Total server entries found in config file */
  totalServers: number
  /** How many have been successfully imported so far */
  importedServers: number
  /** How many were skipped (already exist, duplicate, etc.) */
  skippedServers: number
  /** How many failed to import */
  failedServers: number
  /** Per-entry error messages */
  errors: string[]
  /** Path to the fleet config file being imported */
  configFilePath: string
}

export type SshCredentialRequest = {
  requestId: string
  targetId: string
  kind: 'passphrase' | 'password'
  detail: string
}

// ─── Health Monitoring Types (CR-005) ─────────────────────────────────────────

export type ServerHealthMetrics = {
  serverId: string
  lastCheckedAt: number
  isReachable: boolean
  uptimeSeconds: number | null
  relayVersion: string | null
  nodeVersion: string | null
  diskUsagePercent: number | null
  cpuUsagePercent: number | null
  memUsagePercent: number | null
}

export type ProvisioningStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'provisioning'; step: string; progress: number }
  | { phase: 'done'; linuxUsername: string }
  | { phase: 'error'; message: string }

export type SshUserAccount = {
  linuxUsername: string
  provisioned: boolean
  provisioningStatus: ProvisioningStatus
}

export type FleetAlertType = 'disconnected' | 'error' | 'relay-outdated'

export type FleetAlert = {
  id: string
  serverId: string
  serverLabel: string
  type: FleetAlertType
  message: string
  timestamp: number
  dismissed: boolean
}
