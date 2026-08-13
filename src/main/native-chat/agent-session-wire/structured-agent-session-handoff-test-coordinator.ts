import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

type TestCoordinatorInput = {
  store: AgentSessionRecordStore
  journal: AgentSessionJournal
  sessionId: string
  provider: 'claude' | 'codex'
  claudeSessionId: string
  codexThreadId: string
  now: number
  launchTui: StructuredAgentSessionHandoffTransport['launchTui']
  reproveTuiOwner: StructuredAgentSessionHandoffTransport['reproveTuiOwner']
  stopRecoveredOwner: StructuredAgentSessionHandoffTransport['stopRecoveredOwner']
  closeTuiOwner: NonNullable<StructuredAgentSessionHandoffTransport['closeTuiOwner']>
  waitForTuiExit: StructuredAgentSessionHandoffTransport['waitForTuiExit']
  waitForTuiIdleOrExit: StructuredAgentSessionHandoffTransport['waitForTuiIdleOrExit']
  stopFailedTuiLaunch: NonNullable<StructuredAgentSessionHandoffTransport['stopFailedTuiLaunch']>
  recoverTuiOwner: (record: AgentSessionRecord) => Promise<StructuredTuiOwner>
  tuiStatus: () => 'idle' | 'busy'
  acquireNative: (input: {
    sessionId: string
    fence: number
    spawnToken: string
  }) => Promise<AgentSessionRecord>
  acquireNativeStop: (turnId: string) => Promise<boolean>
  takeImportFailure: () => Error | null
  statuses: AgentSessionHandoffStatus[]
}

export function createStructuredAgentSessionHandoffTestCoordinator(
  input: TestCoordinatorInput
): StructuredAgentSessionHandoffCoordinator {
  return new StructuredAgentSessionHandoffCoordinator({
    store: input.store,
    claimKeyId: 'key-1',
    transport: {
      hostLabel: 'Test host',
      launchTui: input.launchTui,
      reproveTuiOwner: input.reproveTuiOwner,
      recoverTuiOwner: input.recoverTuiOwner,
      stopRecoveredOwner: input.stopRecoveredOwner,
      closeTuiOwner: input.closeTuiOwner,
      waitForTuiExit: input.waitForTuiExit,
      waitForTuiIdleOrExit: input.waitForTuiIdleOrExit,
      tuiStatus: input.tuiStatus,
      stopFailedTuiLaunch: input.stopFailedTuiLaunch
    },
    session: () => ({
      journal: input.journal,
      fence: input.store.getRecord(input.sessionId)?.lease.runtimeFence ?? 1
    }),
    suspendNative: async () => undefined,
    acquireNative: input.acquireNative,
    acquireNativeStop: (_sessionId, turnId) => input.acquireNativeStop(turnId),
    importTuiHistory: async ({ fence }) => {
      const importFailure = input.takeImportFailure()
      if (importFailure) {
        throw importFailure
      }
      await input.journal.appendItem(
        input.provider === 'claude'
          ? { provider: 'claude', sessionId: input.claudeSessionId, uuid: 'tui-turn' }
          : { provider: 'codex', threadId: input.codexThreadId, turnId: 'tui-turn', ordinal: 0 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'from tui' }] },
        { fence, recovered: true }
      )
    },
    publish: (_sessionId, status) => input.statuses.push(status),
    schedule: async (_sessionId, task) => task(),
    now: () => input.now
  })
}
