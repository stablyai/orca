import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionReadRestoreDeps } from './structured-agent-session-restart-restore'
import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'

export class StructuredAgentSessionReadableRestorer {
  constructor(
    private readonly input: StructuredAgentSessionReadRestoreDeps & {
      supportsRecord: (record: AgentSessionRecord) => boolean
    }
  ) {}

  restore(sessionIds?: readonly string[]): Promise<void> {
    return this.restoreReadableSessions(sessionIds)
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
