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
      /** Reaps children carrying a token no lease claims, before recovery grants a new owner. */
      reapOrphanChildren?: () => Promise<unknown>
    }
  ) {}

  restore(): Promise<void> {
    this.restorePromise ??= this.reapThenRestore().catch((error: unknown) => {
      this.restorePromise = null
      throw error
    })
    return this.restorePromise
  }

  private async reapThenRestore(): Promise<void> {
    // A lost record leaves its child unreferenced while recovery is about to hand the same
    // provider session a fresh owner, so the orphan has to be stopped before that, not after.
    await this.input.reapOrphanChildren?.()
    await restoreStructuredAgentSessionsOnRestart({
      ...this.input,
      records: this.input.store.listRecords().filter(this.input.supportsRecord)
    })
  }
}
