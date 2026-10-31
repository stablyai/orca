import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionConversations } from '../../native-chat/agent-session-wire/structured-agent-session-conversations'
import { StructuredAgentSessionRequestFailures } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'
import { hostTestAttachParams } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { escalateChatWorkerError } from './chat-worker-error-escalation'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import type { JournalLifecycleMutationInput } from '../../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionRequestFailure } from '../../native-chat/agent-session-wire/structured-agent-session-request-failures'
import type { StructuredAgentSessionHostSession } from '../../native-chat/agent-session-wire/structured-agent-session-host-types'

export const SESSION = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
export let journals = createTrackedJournalOpener()
const roots: string[] = []
const databases: OrchestrationDb[] = []
let scopedOwnership = false
const ownedRigs: {
  root: string
  db?: OrchestrationDb
  operations: Promise<unknown>[]
  stop?: () => void
  release?: () => void
}[] = []
export function registerScopedRequestFailureOwnership(): void {
  scopedOwnership = true
  journals = createTrackedJournalOpener({ scoped: true })
}
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
afterEach(async () => {
  if (scopedOwnership) {
    const owned = ownedRigs.splice(0)
    const directories = roots.splice(0)
    databases.splice(0)
    const failures: unknown[] = []
    const blocked = new Set<string>()
    for (const rig of owned) {
      try {
        rig.stop?.()
      } catch (error) {
        blocked.add(rig.root)
        failures.push(error)
      }
    }
    await tick()
    for (const rig of owned) {
      do {
        for (const result of await Promise.allSettled(rig.operations.splice(0))) {
          if (result.status === 'rejected') {
            blocked.add(rig.root)
            failures.push(result.reason)
          }
        }
      } while (rig.operations.length > 0)
      if (!blocked.has(rig.root)) {
        try {
          rig.release?.()
          rig.db?.close()
        } catch (error) {
          blocked.add(rig.root)
          failures.push(error)
        }
      }
    }
    try {
      await journals.dispose(directories, [...blocked])
    } catch (error) {
      failures.push(error)
    }
    vi.restoreAllMocks()
    if (failures.length > 0) {
      throw new AggregateError(failures, 'request-failure rig cleanup failed', { cause: owned })
    }
    return
  }
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
  const owned: (typeof ownedRigs)[number] | null = scopedOwnership ? { root, operations: [] } : null
  if (owned) {
    ownedRigs.push(owned)
    journals.ownRoot(root)
  }
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
  if (owned) {
    owned.db = db
  }
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
  const failures = vi.fn((failure: StructuredAgentSessionRequestFailure) => {
    const operation = escalateChatWorkerError(failure, {
      getDb: () => db,
      isWaitingForMail: () => false,
      notify
    })
    if (owned) {
      owned.operations.push(operation)
      void operation.catch(() => undefined)
    }
  })
  const observer = new StructuredAgentSessionRequestFailures({
    sessions,
    capturePendingOutput,
    wordsContext: () => ({ agentName: 'Codex', retryControl: true }),
    onFailure: failures
  })
  const session: StructuredAgentSessionHostSession = {
    journal,
    params: hostTestAttachParams(null),
    child: null
  }
  if (owned) {
    owned.stop = () => {
      for (const current of sessions.values()) {
        current.journal.observeCommits(() => {})
      }
    }
  }
  if (owned) {
    owned.release = () => {
      for (const id of sessions.keys()) {
        sessions.delete(id)
      }
    }
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
    failures,
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
