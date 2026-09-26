import type { AgentSessionLease } from '../../shared/agent-session-record'
import { raiseAgentSessionFencesAfterBackupRecovery } from './agent-session-backup-recovery-fence'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStoreExactPrimarySha256,
  agentSessionStoreRevision,
  agentSessionStoreSerializedRevision,
  loadAgentSessionStore,
  saveAgentSessionStore,
  type AgentSessionStoreState,
  type LoadedAgentSessionStore
} from './agent-session-record-store-file'
import {
  agentSessionStoreDraftChanges,
  assertAgentSessionStoreDraftReadable,
  draftAgentSessionStoreState
} from './agent-session-store-draft'
import {
  agentSessionStoreBytesSha256,
  readAgentSessionStorePrimary
} from './agent-session-store-primary-bytes'
import { withFileTransactionLock } from '../file-transaction-lock'

/** Latch fields older builds wrote. Nothing reads them, and dropping them keeps a lease this build
 *  writes back from carrying a stale latch to an older build after a downgrade. */
type RetiredAgentSessionLeaseFields = {
  processlessAt?: unknown
  settlementRetryRequired?: unknown
  settlementRetryId?: unknown
}

function markLoadedLeasesUnreconciled(state: AgentSessionStoreState): void {
  for (const [sessionId, record] of state.records) {
    const lease: AgentSessionLease & RetiredAgentSessionLeaseFields = record.lease
    const {
      processlessAt: _processlessAt,
      settlementRetryRequired: _settlementRetryRequired,
      settlementRetryId: _settlementRetryId,
      ...current
    } = lease
    state.records.set(sessionId, {
      ...record,
      lease: { ...current, unreconciled: true }
    })
  }
}

export class AgentSessionStoreTransactionQueue {
  private queue: Promise<unknown> = Promise.resolve()
  private diskRecoveredFromBackup: boolean
  /** Hash of the primary bytes `diskRevision` is exactly derived from; null forces a full load. */
  private primarySha256: string | null

  constructor(
    private readonly filePath: string,
    readonly hostId: string,
    readonly readOnly: boolean,
    readonly recoveredFromBackup: boolean,
    private diskStoreFound: boolean,
    private published: AgentSessionStoreState,
    private diskRevision: string,
    private needsRewrite: boolean,
    primarySha256: string | null
  ) {
    this.diskRecoveredFromBackup = recoveredFromBackup
    this.primarySha256 = primarySha256
  }

  static fromLoadedStore(
    filePath: string,
    hostId: string,
    loaded: LoadedAgentSessionStore,
    diskRevision: string
  ): AgentSessionStoreTransactionQueue {
    return new AgentSessionStoreTransactionQueue(
      filePath,
      hostId,
      loaded.readOnly,
      loaded.recoveredFromBackup,
      loaded.storeFound,
      loaded.state,
      diskRevision,
      loaded.needsRewrite,
      agentSessionStoreExactPrimarySha256(loaded)
    )
  }

  /** The durable state. A transaction in flight never shows here until its save has landed. */
  get state(): AgentSessionStoreState {
    return this.published
  }

  /** `apply` changes the draft it is given; the draft is published only after a durable save. */
  transact<T>(apply: (draft: AgentSessionStoreState) => T): Promise<T> {
    const run = this.queue.then(() =>
      withFileTransactionLock(this.filePath, async () => {
        if (this.readOnly) {
          throw new Error('agent_session_legacy_required')
        }
        await this.refreshExternallyChangedState()
        const draft = draftAgentSessionStoreState(this.published)
        // The lost commit may have granted a higher fence than the backup records show. Rather
        // than refuse forever, raise every recovered fence clear of anything that commit could
        // have minted, then continue in the same transaction.
        const recovering = this.diskRecoveredFromBackup
        if (recovering) {
          raiseAgentSessionFencesAfterBackupRecovery(draft)
        }
        const result = apply(draft)
        const changes = agentSessionStoreDraftChanges(this.published, draft)
        if (!recovering && !this.needsRewrite && !changes.changed) {
          return result
        }
        assertAgentSessionStoreDraftReadable(draft, changes)
        const savedSchemaVersion = draft.schemaVersion
        const written = await saveAgentSessionStore(this.filePath, draft, {
          primaryStatus: this.diskStoreFound && !recovering ? 'validated' : 'unusable-or-absent'
        })
        draft.schemaVersion = AGENT_SESSION_STORE_SCHEMA_VERSION
        this.published = draft
        this.diskRevision = agentSessionStoreSerializedRevision(savedSchemaVersion, written)
        this.primarySha256 = agentSessionStoreBytesSha256(written)
        this.diskRecoveredFromBackup = false
        this.diskStoreFound = true
        this.needsRewrite = false
        return result
      })
    )
    this.queue = run.catch(() => {})
    return run
  }

  persistLoadedRewrite(): Promise<void> {
    return this.transact(() => undefined)
  }

  private async refreshExternallyChangedState(): Promise<void> {
    const primary = await readAgentSessionStorePrimary(this.filePath)
    if (primary !== null && primary.sha256 === this.primarySha256) {
      // Why: the exact bytes the durable state was last loaded from or written as.
      return
    }
    const loaded = await loadAgentSessionStore(this.filePath, this.hostId, primary)
    if (this.diskStoreFound && !loaded.storeFound) {
      throw new Error('agent_session_store_corrupt')
    }
    this.diskStoreFound ||= loaded.storeFound
    const diskRevision = agentSessionStoreRevision(loaded.state)
    this.diskRecoveredFromBackup = loaded.recoveredFromBackup
    if (diskRevision === this.diskRevision) {
      this.needsRewrite ||= loaded.needsRewrite
      this.primarySha256 = agentSessionStoreExactPrimarySha256(loaded)
      return
    }
    if (loaded.readOnly) {
      throw new Error('agent_session_legacy_required')
    }
    markLoadedLeasesUnreconciled(loaded.state)
    this.published = loaded.state
    this.diskRevision = diskRevision
    this.needsRewrite = loaded.needsRewrite
    this.primarySha256 = agentSessionStoreExactPrimarySha256(loaded)
  }
}

export function markAgentSessionStoreLeasesUnreconciled(state: AgentSessionStoreState): void {
  markLoadedLeasesUnreconciled(state)
}
