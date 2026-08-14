import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import {
  attachParamsForRecord,
  restoreStructuredAgentSessionRead,
  type RestoredStructuredAgentSessionRead
} from './structured-agent-session-read-restore'

export async function restoreStructuredAgentSessionsOnRestart(input: {
  store: AgentSessionRecordStore
  journalRoot: string
  records: AgentSessionRecord[]
  reconcile: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  operationId: () => string
  resume: (params: AgentSessionAttachParams) => Promise<boolean>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  onReadable: (sessionId: string, restored: RestoredStructuredAgentSessionRead) => void
  restoreHandoff: (sessionId: string) => Promise<void>
}): Promise<void> {
  await Promise.all(
    input.records.map(async ({ sessionId }) => {
      const unreconciled = await input.reconcile(sessionId)
      const current = input.store.getRecord(sessionId)
      if (
        !unreconciled &&
        current?.lease.claimStatus === 'released' &&
        current.lease.handoffStage === null &&
        (await input.resume(
          attachParamsForRecord(current, {
            clientOperationId: input.operationId(),
            expectedRuntimeFence: current.lease.runtimeFence,
            runtimeKind: 'native'
          })
        ))
      ) {
        return
      }
      await input.serialize(sessionId, async () => {
        if (input.hasSession(sessionId)) {
          await input.restoreHandoff(sessionId)
          return
        }
        const restored = await restoreStructuredAgentSessionRead(
          input.store,
          input.journalRoot,
          sessionId
        )
        if (!restored) {
          return
        }
        input.onReadable(sessionId, restored)
        await input.restoreHandoff(sessionId)
      })
    })
  )
}
