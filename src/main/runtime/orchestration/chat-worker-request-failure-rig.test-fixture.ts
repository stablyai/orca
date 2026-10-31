import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import type { JournalLifecycleMutationInput } from '../../native-chat/agent-session-journal/journal-row-builders'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionConversations } from '../../native-chat/agent-session-wire/structured-agent-session-conversations'
import { StructuredAgentSessionRequestFailures } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'
import type { StructuredAgentSessionHostSession } from '../../native-chat/agent-session-wire/structured-agent-session-host-types'
import { hostTestAttachParams } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from './chat-worker-error-escalation'

export const SESSION = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
export const journals = createTrackedJournalOpener()
const roots: string[] = []
const databases: OrchestrationDb[] = []
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
afterEach(async () => {
  vi.restoreAllMocks()
  await tick()
  await journals.closeAll()
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

export async function rig(
  capturePendingOutput?: StructuredAgentSessionAdapter['capturePendingOutput']
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-pr31941-requests-'))
  roots.push(root)
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    }
  })
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const run = db.createRun({
    objective: 'ship',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  const assign = () =>
    createRootDispatch(
      db,
      db.createTask({ spec: 'work', runId: run.id }).id,
      formatOrcaSessionAddress(SESSION)
    )
  let dispatch = assign()
  const notify = vi.fn<(handle: string, messageType: string) => void>()
  const deliver = vi.fn<(sessionId: string, journal: AgentSessionJournal) => void>()
  const sessions = new StructuredAgentSessionConversations({
    deliver,
    now: () => 0,
    logger: recordingStructuredAgentSessionLogger().logger,
    observe: (...args) => observer.observe(...args),
    forget: (id) => observer.forget(id)
  })
  const observer = new StructuredAgentSessionRequestFailures({
    sessions,
    capturePendingOutput,
    wordsContext: () => ({ agentName: 'Codex', retryControl: true }),
    onFailure: (failure) => {
      void escalateChatWorkerError(failure, {
        getDb: () => db,
        notify,
        isWaitingForMail: () => false
      })
    }
  })
  const session: StructuredAgentSessionHostSession = {
    journal,
    params: hostTestAttachParams(null),
    child: null
  }
  sessions.set(SESSION, session)
  return {
    root,
    journal,
    observer,
    sessions,
    session,
    db,
    notify,
    deliver,
    mail: () => db.getUnreadRunMailbox(run.id, 100, ['escalation']),
    dispatch: () => dispatch,
    unassign: () => db.completeDispatch(dispatch.id),
    reassign: () => {
      db.completeDispatch(dispatch.id)
      dispatch = assign()
    }
  }
}
export function mutation(
  id: string,
  body: AgentJournalItemBody,
  turnId?: string
): Extract<JournalLifecycleMutationInput, { kind: 'item' }> {
  return {
    kind: 'item',
    itemId: id,
    body,
    turnScope: turnId ? { kind: 'turn', turnItemId: turnId } : AGENT_JOURNAL_THREAD_SCOPE
  }
}
export const turn = (id: string, outcome: 'failure' | 'success'): JournalLifecycleMutationInput =>
  mutation(id, { kind: 'turn', turnId: id, state: 'completed', outcome })
export const words = (id: string, text: string): JournalLifecycleMutationInput =>
  mutation(`error:${id}`, { kind: 'status', tone: 'error', text }, id)
export async function batch(
  journal: AgentSessionJournal,
  id: string,
  mutations: JournalLifecycleMutationInput[]
) {
  await journal.appendLifecycleBatch({ settlementId: id, fence: 0, mutations })
}
