import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionReadRestoreDeps } from './structured-agent-session-restart-restore'
import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'

export class StructuredAgentSessionReadableRestorer {
  private restorePromise: Promise<void> | null = null
  private restoring = false

  constructor(
    private readonly input: StructuredAgentSessionReadRestoreDeps & {
      supportsRecord: (record: AgentSessionRecord) => boolean
    }
  ) {}

  restore(sessionIds?: readonly string[]): Promise<void> {
    if (!this.restorePromise) {
      this.restoring = true
      this.restorePromise = this.restoreReadableSessions(sessionIds)
        .catch((error: unknown) => {
          this.restorePromise = null
          throw error
        })
        .finally(() => {
          this.restoring = false
        })
    }
    return this.restorePromise
  }

  /** A history restore has started and not finished. */
  get isRestoring(): boolean {
    return this.restoring
  }

  private async restoreReadableSessions(sessionIds?: readonly string[]): Promise<void> {
    const targetOrder = sessionIds
      ? new Map(sessionIds.map((sessionId, index) => [sessionId, index]))
      : null
    const records = this.input.openDeps.store
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
