import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SshConnectionState,
  PortForwardEntry,
  EnrichedDetectedPort,
  SshTarget
} from '../../../../shared/ssh-types'
import {
  buildRemovedSshTargetCleanupPatch,
  sshConnectionStatesEqual,
  sshTargetLabelsEqual
} from './ssh-target-cleanup'
import {
  getRuntimeSshState,
  listRuntimeSshRemovedTargetLabels,
  listRuntimeSshTargets
} from '../../runtime/runtime-ssh-client'
// Domain types split into ssh-slice-types.ts to keep this file under
// oxlint's max-lines budget; re-exported so existing `from '.../slices/ssh'`
// imports keep working unchanged.
export type {
  RemoteWorkspaceSyncStatus,
  FleetImportPhase,
  FleetImportStatus,
  SshCredentialRequest,
  ServerHealthMetrics,
  ProvisioningStatus,
  SshUserAccount,
  FleetAlertType,
  FleetAlert
} from './ssh-slice-types'
import type {
  RemoteWorkspaceSyncStatus,
  FleetImportPhase,
  FleetImportStatus,
  SshCredentialRequest,
  ServerHealthMetrics,
  ProvisioningStatus,
  SshUserAccount,
  FleetAlert
} from './ssh-slice-types'

export type SshSlice = {
  sshUserAccounts: Map<string, SshUserAccount>
  setSshUserAccount: (serverId: string, account: SshUserAccount) => void
  updateProvisioningStatus: (serverId: string, status: ProvisioningStatus) => void

  sshConnectionStates: Map<string, SshConnectionState>
  /** Maps target IDs to their user-facing labels. Populated during hydration
   * so components can look up labels without per-component IPC calls. */
  sshTargetLabels: Map<string, string>
  /** Maps REMOVED target IDs to their last known label (from re-adoption
   * tombstones). Lets ghost-host UI show a friendly name instead of the raw id
   * for a workspace still pinned to a deleted target. */
  removedSshTargetLabels: Map<string, string>
  /** True once a target list actually loaded (even an empty one). Distinguishes
   * "this client knows the target set" from "never hydrated" (e.g. a paired
   * client on a host without the ssh RPC), so absence from sshTargetLabels
   * only counts as removal evidence when this is set. */
  sshTargetsHydrated: boolean
  remoteWorkspaceHydratedTargetIds: Set<string>
  remoteWorkspaceSyncStatusByTargetId: Record<string, RemoteWorkspaceSyncStatus>
  sshCredentialQueue: SshCredentialRequest[]
  /** Incremented when an SSH target transitions to 'connected'. Allows
   * components like the file explorer to re-trigger data loads that failed
   * before the connection was established. */
  sshConnectedGeneration: number
  /** Port forwards keyed by connection ID. Updated via push events from main.
   *  Why Record instead of Map: Zustand selectors use shallow-equality on plain
   *  objects. Spreading a Record produces a new reference that Zustand can diff
   *  by identity, whereas Map mutations are easy to get wrong. */
  portForwardsByConnection: Record<string, PortForwardEntry[]>
  /** Detected remote listening ports after main-process enrichment, keyed by
   *  connection ID. Updated from SSH IPC snapshots and push events. */
  detectedPortsByConnection: Record<string, EnrichedDetectedPort[]>
  /** Fleet config import progress (CR-001). Null when no import is active. */
  fleetImportStatus: FleetImportStatus | null
  /** Full SSH target list synced from backend (CR-002). Used for grouping/filtering UI. */
  sshTargets: SshTarget[]
  /** Collapsed state for project groups in the SSH fleet view (CR-002).
   *  Keyed by project name or '__unassigned__' for ungrouped targets. */
  collapsedSshGroups: Record<string, boolean>
  /** Fleet alert notifications — disconnect events and relay issues (CR-005). */
  fleetAlerts: FleetAlert[]
  /** Health metrics per server — synced from backend polling (CR-005). */
  serverHealthMetrics: Record<string, ServerHealthMetrics>
  /** Timestamp of the last successful fleet health poll (CR-005). */
  lastFleetHealthCheck: number | null
  setSshConnectionState: (targetId: string, state: SshConnectionState) => void
  /** Hydrates sshTargets/sshTargetLabels/removedSshTargetLabels/
   *  sshConnectionStates from the backend read RPCs (ListSshTargets/
   *  GetSshState) — CR-STORAGE-006's hydrate-on-mount pattern (FE-TASK-
   *  STORAGE-013). Additive: App.tsx/useIpcEvents.ts already run an
   *  equivalent inline hydrate at startup/reconnect and keep doing so
   *  unchanged; this gives the slice its own testable entry point without
   *  replacing that live-update path. Swallows RPC failures so a caller
   *  never crashes on a stale/unreachable target list.
   */
  hydrateSshTargets: () => Promise<void>
  setSshTargetLabels: (labels: Map<string, string>) => void
  setRemovedSshTargetLabels: (labels: Record<string, string>) => void
  setSshTargetsMetadata: (targets: Pick<SshTarget, 'id' | 'label'>[]) => void
  clearRemovedSshTargetState: (targetId: string) => void
  markRemoteWorkspaceHydrated: (targetId: string) => void
  clearRemoteWorkspaceHydrated: (targetId: string) => void
  setRemoteWorkspaceSyncStatus: (targetId: string, status: RemoteWorkspaceSyncStatus) => void
  enqueueSshCredentialRequest: (req: SshCredentialRequest) => void
  removeSshCredentialRequest: (requestId: string) => void
  setPortForwards: (targetId: string, forwards: PortForwardEntry[]) => void
  clearPortForwards: (targetId: string) => void
  setDetectedPorts: (targetId: string, ports: EnrichedDetectedPort[]) => void
  /** Update fleet import progress. Merges partial into existing status. (CR-001) */
  setFleetImportStatus: (status: Partial<FleetImportStatus> & { phase: FleetImportPhase }) => void
  /** Reset fleet import status to null (idle). (CR-001) */
  clearFleetImportStatus: () => void
  /** Replace full SSH target list (CR-002). Called from IPC hydration / useIpcEvents. */
  setSshTargets: (targets: SshTarget[]) => void
  /** Toggle collapsed state for a project group key (CR-002). */
  toggleSshGroupCollapsed: (groupKey: string) => void
  // ── Health Monitoring Actions (CR-005) ──────────────────────────────────────
  /** Merge partial health metrics for a single server. */
  updateServerHealth: (serverId: string, metrics: Partial<ServerHealthMetrics>) => void
  /** Record the timestamp of the most recent fleet health poll. */
  setLastFleetHealthCheck: (ts: number) => void
  /** Add a fleet-level alert (disconnect / relay-outdated etc.). */
  addFleetAlert: (alert: FleetAlert) => void
  /** Soft-dismiss an alert by id — keeps it in the array but hides from UI. */
  dismissFleetAlert: (alertId: string) => void
  /** Purge all soft-dismissed alerts from the array. */
  clearDismissedAlerts: () => void
}

const FLEET_IMPORT_IDLE: FleetImportStatus = {
  phase: 'idle',
  totalServers: 0,
  importedServers: 0,
  skippedServers: 0,
  failedServers: 0,
  errors: [],
  configFilePath: ''
}

export const createSshSlice: StateCreator<AppState, [], [], SshSlice> = (set, get) => ({
  sshUserAccounts: new Map(),
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map(),
  removedSshTargetLabels: new Map(),
  sshTargetsHydrated: false,
  remoteWorkspaceHydratedTargetIds: new Set(),
  remoteWorkspaceSyncStatusByTargetId: {},
  sshCredentialQueue: [],
  sshConnectedGeneration: 0,
  portForwardsByConnection: {},
  detectedPortsByConnection: {},
  fleetImportStatus: null,
  sshTargets: [],
  collapsedSshGroups: {},
  // ── Health Monitoring State (CR-005) ──────────────────────────────────────
  serverHealthMetrics: {},
  lastFleetHealthCheck: null,
  fleetAlerts: [],

  setSshConnectionState: (targetId, state) =>
    set((s) => {
      const next = new Map(s.sshConnectionStates)
      const previous = next.get(targetId)
      if (sshConnectionStatesEqual(previous, state)) {
        return s
      }
      next.set(targetId, state)
      return {
        sshConnectionStates: next,
        sshConnectedGeneration:
          previous?.status !== 'connected' && state.status === 'connected'
            ? s.sshConnectedGeneration + 1
            : s.sshConnectedGeneration
      }
    }),

  hydrateSshTargets: async () => {
    const settings = get().settings
    let targets: SshTarget[]
    try {
      targets = await listRuntimeSshTargets(settings)
    } catch {
      // Why: a failed RPC must not crash the caller or wipe out sshTargets
      // state a prior successful hydrate/poll already populated.
      return
    }
    get().setSshTargetsMetadata(targets)
    get().setSshTargets(targets)
    try {
      const removedLabels = await listRuntimeSshRemovedTargetLabels(settings)
      get().setRemovedSshTargetLabels(removedLabels)
    } catch {
      // Best-effort — ghost-host labels just fall back to the raw target id.
    }
    await Promise.all(
      targets.map(async (t) => {
        try {
          const state = await getRuntimeSshState(settings, t.id)
          if (state) {
            get().setSshConnectionState(t.id, state)
          }
        } catch {
          // A target this client can't currently reach just reads 'disconnected'.
        }
      })
    )
  },

  setSshTargetLabels: (labels) => set({ sshTargetLabels: labels }),
  setRemovedSshTargetLabels: (labels) =>
    set({ removedSshTargetLabels: new Map(Object.entries(labels)) }),
  setSshTargetsMetadata: (targets) =>
    set((s) => {
      if (sshTargetLabelsEqual(s.sshTargetLabels, targets)) {
        // Why: an unchanged (even empty) list is still a successful load — the
        // hydration flag must flip on the first fetch of an empty target set.
        return s.sshTargetsHydrated ? s : { sshTargetsHydrated: true }
      }
      return {
        sshTargetLabels: new Map(targets.map((target) => [target.id, target.label])),
        sshTargetsHydrated: true
      }
    }),
  clearRemovedSshTargetState: (targetId) =>
    set((s) => buildRemovedSshTargetCleanupPatch(s, targetId) ?? s),
  markRemoteWorkspaceHydrated: (targetId) =>
    set((s) => {
      const next = new Set(s.remoteWorkspaceHydratedTargetIds)
      next.add(targetId)
      return { remoteWorkspaceHydratedTargetIds: next }
    }),
  clearRemoteWorkspaceHydrated: (targetId) =>
    set((s) => {
      const next = new Set(s.remoteWorkspaceHydratedTargetIds)
      next.delete(targetId)
      return { remoteWorkspaceHydratedTargetIds: next }
    }),
  setRemoteWorkspaceSyncStatus: (targetId, status) =>
    set((s) => ({
      remoteWorkspaceSyncStatusByTargetId: {
        ...s.remoteWorkspaceSyncStatusByTargetId,
        [targetId]: status
      }
    })),
  enqueueSshCredentialRequest: (req) =>
    set((s) => ({ sshCredentialQueue: [...s.sshCredentialQueue, req] })),
  removeSshCredentialRequest: (requestId) =>
    set((s) => ({
      sshCredentialQueue: s.sshCredentialQueue.filter((req) => req.requestId !== requestId)
    })),

  setPortForwards: (targetId, forwards) =>
    set((s) => {
      const next = { ...s.portForwardsByConnection }
      if (forwards.length > 0) {
        next[targetId] = forwards
      } else {
        delete next[targetId]
      }
      return { portForwardsByConnection: next }
    }),

  clearPortForwards: (targetId) =>
    set((s) => {
      const { [targetId]: _, ...rest } = s.portForwardsByConnection
      return { portForwardsByConnection: rest }
    }),

  setDetectedPorts: (targetId, ports) =>
    set((s) => {
      const next = { ...s.detectedPortsByConnection }
      if (ports.length > 0) {
        next[targetId] = ports
      } else {
        delete next[targetId]
      }
      return { detectedPortsByConnection: next }
    }),

  // ── Fleet Import Actions (CR-001) ──────────────────────────────────────────

  setFleetImportStatus: (status) =>
    set((s) => ({
      fleetImportStatus: {
        ...(s.fleetImportStatus ?? FLEET_IMPORT_IDLE),
        ...status
      }
    })),

  clearFleetImportStatus: () => set({ fleetImportStatus: null }),

  // ── Grouping Actions (CR-002) ───────────────────────────────────────────────

  setSshTargets: (targets) =>
    set((s) => {
      // Why: avoid re-render when the list reference is unchanged (e.g. same
      // targets re-emitted during periodic sync).
      if (s.sshTargets === targets) {
        return s
      }
      return { sshTargets: targets }
    }),

  toggleSshGroupCollapsed: (groupKey) =>
    set((s) => ({
      collapsedSshGroups: {
        ...s.collapsedSshGroups,
        [groupKey]: !s.collapsedSshGroups[groupKey]
      }
    })),

  // ── Health Monitoring Implementations (CR-005) ─────────────────────────────

  updateServerHealth: (serverId, metrics) =>
    set((s) => {
      const existing: ServerHealthMetrics = s.serverHealthMetrics[serverId] ?? {
        serverId,
        lastCheckedAt: 0,
        isReachable: false,
        uptimeSeconds: null,
        relayVersion: null,
        nodeVersion: null,
        diskUsagePercent: null,
        cpuUsagePercent: null,
        memUsagePercent: null
      }
      return {
        serverHealthMetrics: {
          ...s.serverHealthMetrics,
          [serverId]: { ...existing, ...metrics }
        }
      }
    }),

  setLastFleetHealthCheck: (ts) => set({ lastFleetHealthCheck: ts }),

  addFleetAlert: (alert) => set((s) => ({ fleetAlerts: [...s.fleetAlerts, alert] })),

  dismissFleetAlert: (alertId) =>
    set((s) => ({
      fleetAlerts: s.fleetAlerts.map((a) => (a.id === alertId ? { ...a, dismissed: true } : a))
    })),

  clearDismissedAlerts: () =>
    set((s) => ({
      fleetAlerts: s.fleetAlerts.filter((a) => !a.dismissed)
    }))
})
