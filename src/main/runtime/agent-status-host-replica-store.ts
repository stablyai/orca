import { isDeepStrictEqual } from 'node:util'

import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  AgentStatusStoreReplica,
  agentStatusStoreRowIdentity,
  agentStatusStoreRowKey,
  type AgentStatusStoreFrame,
  type AgentStatusStoreReplicaApplyResult,
  type AgentStatusStoreReplicaContact,
  type AgentStatusStoreReplicaHostSnapshot
} from '../../shared/agent-status-store-replication'

export type AgentStatusHostReplicaRouting = {
  executionHostId: ExecutionHostId
  connectionId: string
}

export type AgentStatusHostReplicaRowIdentity = {
  paneKey: string
  worktreeId?: string
  terminalHandle?: string
}

export type AgentStatusHostReplicaRowMutation = {
  executionHostId: ExecutionHostId
  before: AgentStatusHostReplicaRowIdentity | null
  after: AgentStatusHostReplicaRowIdentity | null
}

export type AgentStatusHostReplicaContactMutation = {
  executionHostId: ExecutionHostId
  contact: AgentStatusStoreReplicaContact
}

export type AgentStatusHostReplicaApplyResult = AgentStatusStoreReplicaApplyResult | 'wrong-host'

type RowReceipt = {
  evidenceKey: string
  evidenceReceivedAt: number
  deliveredAt: number
}

function scopedRowKey(executionHostId: ExecutionHostId, row: AgentStatusIpcPayload): string {
  return `${executionHostId}\0${agentStatusStoreRowKey(agentStatusStoreRowIdentity(row))}`
}

function evidenceKey(ownerEpoch: string | null, row: AgentStatusIpcPayload): string {
  const observation = row.observation
  if (observation) {
    return `${ownerEpoch ?? ''}\0${observation.authorityId}\0${observation.incarnation}\0${observation.revision}`
  }
  return `${ownerEpoch ?? ''}\0${row.receivedAt}\0${row.evidenceObservedAt ?? ''}\0${row.stateStartedAt}\0${row.state}`
}

function mutationIdentity(row: AgentStatusIpcPayload): AgentStatusHostReplicaRowIdentity {
  return {
    paneKey: row.paneKey,
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.terminalHandle ? { terminalHandle: row.terminalHandle } : {})
  }
}

/** Runtime-owned replicas for execution hosts reached through this host. Row semantics stay remote-owned. */
export class AgentStatusHostReplicaStore {
  private readonly replica = new AgentStatusStoreReplica()
  private readonly routingByHost = new Map<ExecutionHostId, AgentStatusHostReplicaRouting>()
  private readonly receiptsByRow = new Map<string, RowReceipt>()
  private readonly rowMutationListeners = new Set<
    (mutation: AgentStatusHostReplicaRowMutation) => void
  >()
  private readonly contactMutationListeners = new Set<
    (mutation: AgentStatusHostReplicaContactMutation) => void
  >()
  private deliveredAt = 0

  apply(
    frame: AgentStatusStoreFrame,
    routing: AgentStatusHostReplicaRouting,
    options: { deliveryFloor?: number } = {}
  ): AgentStatusHostReplicaApplyResult {
    if (frame.executionHostId !== routing.executionHostId) {
      return 'wrong-host'
    }
    const previousContact = this.replica.getHostSnapshot(routing.executionHostId).contact
    const before = this.rowsByKey(routing.executionHostId)
    this.routingByHost.set(routing.executionHostId, routing)
    const result = this.replica.apply(frame)
    if (previousContact !== 'live') {
      this.emitContactMutation(routing.executionHostId, 'live')
    }
    if (result !== 'applied') {
      return result
    }
    const snapshot = this.replica.getHostSnapshot(routing.executionHostId)
    const rawAfter = new Map(
      snapshot.rows.map((row) => [agentStatusStoreRowKey(agentStatusStoreRowIdentity(row)), row])
    )
    const deliveryFloor = options.deliveryFloor ?? -1
    for (const row of rawAfter.values()) {
      const receiptKey = scopedRowKey(routing.executionHostId, row)
      const nextEvidenceKey = evidenceKey(snapshot.ownerEpoch, row)
      const previous = this.receiptsByRow.get(receiptKey)
      const unchanged = previous?.evidenceKey === nextEvidenceKey
      if (unchanged) {
        continue
      }
      this.deliveredAt = Math.max(Date.now(), deliveryFloor + 1, this.deliveredAt + 1)
      this.receiptsByRow.set(receiptKey, {
        evidenceKey: nextEvidenceKey,
        evidenceReceivedAt: this.deliveredAt,
        deliveredAt: this.deliveredAt
      })
    }
    for (const [rowKey, row] of before) {
      if (!rawAfter.has(rowKey)) {
        this.receiptsByRow.delete(scopedRowKey(routing.executionHostId, row))
      }
    }
    const after = this.rowsByKey(routing.executionHostId)
    this.emitRowDiff(routing.executionHostId, before, after)
    return result
  }

  setContact(executionHostId: ExecutionHostId, contact: AgentStatusStoreReplicaContact): void {
    const previous = this.replica.getHostSnapshot(executionHostId).contact
    this.replica.setContact(executionHostId, contact)
    if (previous === contact) {
      return
    }
    this.emitContactMutation(executionHostId, contact)
  }

  private emitContactMutation(
    executionHostId: ExecutionHostId,
    contact: AgentStatusStoreReplicaContact
  ): void {
    for (const listener of this.contactMutationListeners) {
      try {
        listener({ executionHostId, contact })
      } catch (error) {
        console.warn('[agent-status-replica] contact listener failed', error)
      }
    }
  }

  abandonHost(executionHostId: ExecutionHostId): void {
    const before = this.rowsByKey(executionHostId)
    this.replica.abandonHost(executionHostId)
    this.routingByHost.delete(executionHostId)
    for (const row of before.values()) {
      this.receiptsByRow.delete(scopedRowKey(executionHostId, row))
    }
    this.emitRowDiff(executionHostId, before, new Map())
  }

  getStatusSnapshot(): AgentStatusIpcPayload[] {
    const executionHostIds = new Set(
      this.replica.getRows().map(({ executionHostId }) => executionHostId)
    )
    return [...executionHostIds].flatMap(
      (executionHostId) => this.getHostSnapshot(executionHostId).rows
    )
  }

  getStatusSnapshotForPane(paneKey: string): AgentStatusIpcPayload[] {
    return this.getStatusSnapshot().filter((row) => row.paneKey === paneKey)
  }

  getHostSnapshot(executionHostId: ExecutionHostId): AgentStatusStoreReplicaHostSnapshot {
    const snapshot = this.replica.getHostSnapshot(executionHostId)
    const routing = this.routingByHost.get(executionHostId)
    return {
      ...snapshot,
      rows: snapshot.rows.map((row) => this.toReaderRow(executionHostId, row, routing))
    }
  }

  subscribeStatusRowMutations(
    listener: (mutation: AgentStatusHostReplicaRowMutation) => void
  ): () => void {
    this.rowMutationListeners.add(listener)
    return () => this.rowMutationListeners.delete(listener)
  }

  subscribeContactMutations(
    listener: (mutation: AgentStatusHostReplicaContactMutation) => void
  ): () => void {
    this.contactMutationListeners.add(listener)
    return () => this.contactMutationListeners.delete(listener)
  }

  private rowsByKey(executionHostId: ExecutionHostId): Map<string, AgentStatusIpcPayload> {
    const snapshot = this.getHostSnapshot(executionHostId)
    return new Map(
      snapshot.rows.map((row) => [agentStatusStoreRowKey(agentStatusStoreRowIdentity(row)), row])
    )
  }

  private toReaderRow(
    executionHostId: ExecutionHostId,
    row: AgentStatusIpcPayload,
    routing: AgentStatusHostReplicaRouting | undefined
  ): AgentStatusIpcPayload {
    const receipt = this.receiptsByRow.get(scopedRowKey(executionHostId, row))
    return {
      ...row,
      connectionId: routing?.connectionId ?? row.connectionId,
      ...(receipt
        ? {
            receivedAt: receipt.deliveredAt,
            replicaEvidenceReceivedAt: receipt.evidenceReceivedAt
          }
        : {})
    }
  }

  private emitRowDiff(
    executionHostId: ExecutionHostId,
    before: ReadonlyMap<string, AgentStatusIpcPayload>,
    after: ReadonlyMap<string, AgentStatusIpcPayload>
  ): void {
    for (const rowKey of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(rowKey) ?? null
      const next = after.get(rowKey) ?? null
      if (isDeepStrictEqual(previous, next)) {
        continue
      }
      const mutation: AgentStatusHostReplicaRowMutation = {
        executionHostId,
        before: previous ? mutationIdentity(previous) : null,
        after: next ? mutationIdentity(next) : null
      }
      for (const listener of this.rowMutationListeners) {
        try {
          listener(mutation)
        } catch (error) {
          console.warn('[agent-status-replica] row listener failed', error)
        }
      }
    }
  }
}
