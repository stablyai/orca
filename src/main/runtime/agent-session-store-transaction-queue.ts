import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStoreRevision,
  loadAgentSessionStore,
  saveAgentSessionStore,
  type AgentSessionStoreState
} from './agent-session-record-store-file'
import { withAgentSessionStoreTransactionLock } from './agent-session-store-transaction-lock'

function markLoadedLeasesUnreconciled(state: AgentSessionStoreState): void {
  for (const [sessionId, record] of state.records) {
    state.records.set(sessionId, {
      ...record,
      lease: { ...record.lease, unreconciled: true }
    })
  }
}

function mapEntriesMatch<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false
    }
  }
  return true
}

function agentSessionStoreStateChanged(
  state: AgentSessionStoreState,
  records: ReadonlyMap<string, AgentSessionRecord>,
  operations: ReadonlyMap<string, AgentSessionOperationRow>,
  retiredClaimKeys: AgentSessionStoreState['retiredClaimKeys']
): boolean {
  return (
    !mapEntriesMatch(state.records, records) ||
    !mapEntriesMatch(state.operations, operations) ||
    state.retiredClaimKeys.length !== retiredClaimKeys.length ||
    state.retiredClaimKeys.some((entry, index) => entry !== retiredClaimKeys[index])
  )
}

export class AgentSessionStoreTransactionQueue {
  private queue: Promise<unknown> = Promise.resolve()
  private diskRecoveredFromBackup: boolean

  constructor(
    private readonly filePath: string,
    readonly hostId: string,
    readonly readOnly: boolean,
    readonly recoveredFromBackup: boolean,
    private diskStoreFound: boolean,
    public state: AgentSessionStoreState,
    private diskRevision: string
  ) {
    this.diskRecoveredFromBackup = recoveredFromBackup
  }

  transact<T>(apply: () => T): Promise<T> {
    const run = this.queue.then(() =>
      withAgentSessionStoreTransactionLock(this.filePath, async () => {
        if (this.readOnly) {
          throw new Error('agent_session_legacy_required')
        }
        await this.refreshExternallyChangedState()
        if (this.diskRecoveredFromBackup) {
          // Why: the missing commit may hold a newer fence, so rollback cannot mint another writer.
          throw new Error('execution_owner_reconciling')
        }
        const records = new Map(this.state.records)
        const operations = new Map(this.state.operations)
        const retiredClaimKeys = [...this.state.retiredClaimKeys]
        try {
          const result = apply()
          if (!agentSessionStoreStateChanged(this.state, records, operations, retiredClaimKeys)) {
            return result
          }
          await saveAgentSessionStore(this.filePath, this.state, {
            recoveredFromBackup: this.diskRecoveredFromBackup
          })
          this.state.schemaVersion = AGENT_SESSION_STORE_SCHEMA_VERSION
          this.diskRevision = agentSessionStoreRevision(this.state)
          this.diskRecoveredFromBackup = false
          this.diskStoreFound = true
          return result
        } catch (error) {
          this.state.records = records
          this.state.operations = operations
          this.state.retiredClaimKeys = retiredClaimKeys
          throw error
        }
      })
    )
    this.queue = run.catch(() => {})
    return run
  }

  private async refreshExternallyChangedState(): Promise<void> {
    const loaded = await loadAgentSessionStore(this.filePath, this.hostId)
    if (this.diskStoreFound && !loaded.storeFound) {
      throw new Error('agent_session_store_corrupt')
    }
    this.diskStoreFound ||= loaded.storeFound
    const diskRevision = agentSessionStoreRevision(loaded.state)
    this.diskRecoveredFromBackup = loaded.recoveredFromBackup
    if (diskRevision === this.diskRevision) {
      return
    }
    if (loaded.readOnly) {
      throw new Error('agent_session_legacy_required')
    }
    markLoadedLeasesUnreconciled(loaded.state)
    this.state = loaded.state
    this.diskRevision = diskRevision
  }
}

export function markAgentSessionStoreLeasesUnreconciled(state: AgentSessionStoreState): void {
  markLoadedLeasesUnreconciled(state)
}
