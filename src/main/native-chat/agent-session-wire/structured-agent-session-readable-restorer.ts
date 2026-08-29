import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { RestoredStructuredAgentSessionRead } from './structured-agent-session-read-restore'
import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'

export class StructuredAgentSessionReadableRestorer {
  private restorePromise: Promise<void> | null = null

  constructor(
    private readonly input: {
      store: AgentSessionRecordStore
      journalRoot: string
      supportsRecord: (record: AgentSessionRecord) => boolean
      reconcile: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
      resolveRecovery: (sessionId: string) => Promise<unknown>
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      hasSession: (sessionId: string) => boolean
      onReadable: (sessionId: string, restored: RestoredStructuredAgentSessionRead) => void
      restoreHandoff: (sessionId: string) => Promise<void>
    }
  ) {}

  restore(sessionIds?: readonly string[]): Promise<void> {
    this.restorePromise ??= this.restoreReadableSessions(sessionIds).catch((error: unknown) => {
      this.restorePromise = null
      throw error
    })
    return this.restorePromise
  }

  private async restoreReadableSessions(sessionIds?: readonly string[]): Promise<void> {
    const targetOrder = sessionIds
      ? new Map(sessionIds.map((sessionId, index) => [sessionId, index]))
      : null
    const records = this.input.store
      .listRecords()
      .filter(
        (record) =>
          this.input.supportsRecord(record) && (!targetOrder || targetOrder.has(record.sessionId))
      )
    if (targetOrder) {
      records.sort(
        (left, right) => targetOrder.get(left.sessionId)! - targetOrder.get(right.sessionId)!
      )
    }
    await restoreStructuredAgentSessionsOnRestart({
      ...this.input,
      records
    })
  }
}
