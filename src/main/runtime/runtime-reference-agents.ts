import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import { composeWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../shared/orca-session-address'
import { peekOpenedAgentSessionRecordStore } from './agent-session-record-store-slot'
import type { OrchestrationDb } from './orchestration/db'
import { structuredSessionMailReach } from './orchestration/structured-session-mail-address'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './orchestration/structured-session-lineage'
import { observeStructuredSession } from './structured-worker-authority'
import { structuredWorkerHostScope } from './structured-worker-identity'
import type { ReferenceAgentCandidate, ReferenceAgentIndex } from './runtime-reference-find'

export type ReferenceAgentSource = {
  getOrchestrationFleetAgentStatusSnapshot: () => readonly FleetAgentStatusEvidence[]
  getAgentProviderSessionRows: () => AgentStatusIpcPayload[]
  getTerminalLivenessVerdict: (handle: string) => PtyLivenessVerdict | null
}

export function referenceConnectionHosts(
  repos: readonly Repo[]
): Map<string, ExecutionHostId | null> {
  const hosts = new Map<string, ExecutionHostId | null>()
  for (const repo of repos) {
    if (!repo.connectionId) {
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    const previous = hosts.get(repo.connectionId)
    hosts.set(repo.connectionId, previous === undefined || previous === hostId ? hostId : null)
  }
  return hosts
}

export function createReferenceAgentIndex(
  runtime: ReferenceAgentSource,
  db: OrchestrationDb | null,
  sessions: AgentSessionRecordReader | null = readAgentSessionRecordStore() ??
    peekOpenedAgentSessionRecordStore(),
  workspaceKeys?: ReadonlySet<string>,
  connectionHosts?: ReadonlyMap<string, ExecutionHostId | null>
): ReferenceAgentIndex {
  const index = new Map<string, ReferenceAgentCandidate[]>()
  const nativePanes = new Set<string>()
  const append = (workspaceId: string, candidate: ReferenceAgentCandidate): void => {
    const key = composeWorktreeHostIdentity(candidate.hostId, workspaceId)
    const entries = index.get(key) ?? []
    entries.push(candidate)
    index.set(key, entries)
  }
  const visible = sessions?.getVisibleSessionTabIndex?.()
  for (const record of sessions?.listRecords() ?? []) {
    if (
      clearedInto(record) ||
      // Why: records outlive their chat tab; a closed chat is not an agent on the workspace.
      (visible?.present && !visible.sessionIds.includes(record.sessionId)) ||
      (workspaceKeys &&
        !workspaceKeys.has(
          composeWorktreeHostIdentity(record.location.executionHostId, record.location.workspaceId)
        ))
    ) {
      continue
    }
    const tabId = structuredAgentSessionTabId(record.sessionId)
    const paneKey = structuredAgentSessionPaneKey(tabId, record.sessionId)
    nativePanes.add(
      JSON.stringify([record.location.executionHostId, record.location.workspaceId, paneKey])
    )
    const local = structuredWorkerHostScope(record.location) !== null
    const reachable =
      local && sessions
        ? structuredSessionMailReach(sessions, record, db).kind === 'reachable'
        : false
    append(record.location.workspaceId, {
      hostId: record.location.executionHostId,
      agent: record.provider,
      paneKey,
      sessionId: record.sessionId,
      sessionIds: [
        record.sessionId,
        ...record.providerHandleChain.map(({ handle }) => handle.nativeId)
      ],
      liveness: local ? observeStructuredSession(record.sessionId).status : 'unverifiable',
      ...(reachable && isOrcaSessionId(record.sessionId)
        ? { mailbox: formatOrcaSessionAddress(record.sessionId) }
        : {})
    })
  }
  const providerSessions = new Map<string, AgentStatusIpcPayload[]>()
  for (const row of runtime.getAgentProviderSessionRows()) {
    if (row.providerSessionOnly || row.restoredUnconfirmed || !row.providerSession) {
      continue
    }
    const key = JSON.stringify([
      row.connectionId,
      row.paneKey,
      row.agentType,
      row.worktreeId,
      row.receivedAt
    ])
    const rows = providerSessions.get(key) ?? []
    rows.push(row)
    providerSessions.set(key, rows)
  }
  const latest = new Map<string, FleetAgentStatusEvidence>()
  for (const evidence of runtime.getOrchestrationFleetAgentStatusSnapshot()) {
    const { binding, activity } = evidence
    const key = JSON.stringify([activity.connectionId, activity.worktreeId, activity.paneKey])
    const previous = latest.get(key)
    if (
      !previous ||
      evidence.deliveredAt > previous.deliveredAt ||
      (evidence.deliveredAt === previous.deliveredAt && binding.kind === 'unresolved')
    ) {
      latest.set(key, evidence)
    }
  }
  for (const { binding, activity, deliveredAt } of latest.values()) {
    if (!activity.worktreeId || !activity.agentType) {
      continue
    }
    const hostId = activity.connectionId
      ? connectionHosts?.has(activity.connectionId)
        ? connectionHosts.get(activity.connectionId)
        : toSshExecutionHostId(activity.connectionId)
      : LOCAL_EXECUTION_HOST_ID
    if (!hostId) {
      continue
    }
    if (
      workspaceKeys &&
      !workspaceKeys.has(composeWorktreeHostIdentity(hostId, activity.worktreeId))
    ) {
      continue
    }
    const paneIdentity = JSON.stringify([hostId, activity.worktreeId, activity.paneKey])
    if (nativePanes.has(paneIdentity)) {
      continue
    }
    const rows =
      providerSessions.get(
        JSON.stringify([
          activity.connectionId,
          activity.paneKey,
          activity.agentType,
          activity.worktreeId,
          deliveredAt
        ])
      ) ?? []
    const sessionIds = new Set(
      rows.map((row) => row.providerSession?.id).filter((id) => id !== undefined)
    )
    const sessionId = sessionIds.size === 1 ? [...sessionIds][0] : undefined
    const terminal = binding.kind === 'unresolved' ? undefined : binding.terminalHandle
    append(activity.worktreeId, {
      hostId,
      agent: activity.agentType,
      ...(terminal ? { paneKey: activity.paneKey } : {}),
      ...(sessionId && terminal ? { sessionIds: [sessionId] } : {}),
      liveness: terminal
        ? (runtime.getTerminalLivenessVerdict(terminal)?.status ?? 'unverifiable')
        : 'unverifiable',
      ...(terminal ? { terminal } : {}),
      ...(binding.kind === 'worker' ? { mailbox: `dispatch:${binding.dispatchId}` } : {})
    })
  }
  return index
}
