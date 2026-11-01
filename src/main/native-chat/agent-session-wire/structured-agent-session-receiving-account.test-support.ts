import { createRestTestRig } from './structured-agent-session-rest-test-rig'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session-record.test-fixture'
import { withAcquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  agentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { isOrcaSessionId } from '../../../shared/orca-session-address'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { structuredNativeWorkReaders } from '../../runtime/structured-native-work-readers'
import { structuredMailNotice } from '../../runtime/orchestration/structured-mail-source'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export const RECEIVING_A = { variable: 'CLAUDE_CONFIG_DIR', path: '/qa/claude-profiles/qa-a/home' }
export const SELECTED_B = { variable: 'CLAUDE_CONFIG_DIR', path: '/qa/claude-profiles/qa-b/home' }
export async function createReceivingAccountFixture() {
  const rig = await createRestTestRig()
  const record = withAcquiredAgentSessionAccount(
    agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: '6e1b4ae5-2354-4ca5-999e-647deeb23894',
        runtimeFence: 2
      })
    ),
    {
      generation: 'generation-2',
      recipe: { route: 'system', home: RECEIVING_A.path, configDir: RECEIVING_A.path }
    }
  )
  const root = record.sessionId
  if (!isOrcaSessionId(root)) {
    throw new Error('fixture requires a canonical session id')
  }
  await seedTestAgentSessionRecordStore(rig.root, { records: [record] })
  const store = await openTestAgentSessionRecordStore(rig.root)
  const journal = new AgentSessionJournal({
    database: openTestJournalHostDatabase(rig.root),
    identity: {
      sessionId: root,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    }
  })
  await journal.open()
  const session: StructuredAgentSessionHostSession = {
    journal,
    params: hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      accountHome: RECEIVING_A
    }),
    child: { phase: 'ready', fence: 2, generation: 'generation-2', accountHome: RECEIVING_A }
  }
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'native parent',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: root
  })
  const deps = {
    ...rig.host.deps,
    store,
    launchAccountHome: async () => SELECTED_B,
    ...structuredNativeWorkReaders(() => db)
  }
  let sends = 0
  const submit = async (
    body: AgentJournalMessageItem,
    origin: 'client' | 'host' = 'host',
    legacy = false
  ) => {
    const clientMessageId = `receiving-${++sends}`
    await journal.appendSubmission({
      clientMessageId,
      payloadFingerprint: clientMessageId,
      ...(legacy ? {} : { handoverRecorded: true }),
      body,
      origin,
      fence: 2
    })
    const submission = journal.submission(clientMessageId)
    if (!submission) {
      throw new Error('submission was not committed')
    }
    return submission
  }
  const turn = async (
    clientMessageId: string,
    state: AgentJournalTurnLifecycle['state'],
    legacy = false
  ) => {
    const identity = {
      provider: 'claude' as const,
      sessionId: 'parent-provider',
      uuid: `turn-${clientMessageId}`
    }
    let userItemId = agentJournalSubmissionKey(clientMessageId)
    const submitted = journal.submission(clientMessageId)
    if (submitted) {
      const echo = {
        provider: 'claude' as const,
        sessionId: 'parent-provider',
        uuid: `echo-${clientMessageId}`
      }
      const body = journal.itemBody(userItemId)
      if (!body) {
        throw new Error('provider echo requires its actual submitted input')
      }
      const turnScope = new StructuredAgentSessionCurrentWork(journal, 2).turnScope()
      if (submitted.handoverRecorded && submitted.handedOverAt === undefined) {
        await journal.resolveDispatch({ clientMessageId, fence: 2, state: 'pending', turnScope })
      }
      await journal.resolveDispatch({
        clientMessageId,
        fence: 2,
        state: 'accepted',
        providerIdentity: echo
      })
      await journal.appendItem(echo, body, { fence: 2, turnScope })
      if (legacy) {
        userItemId = agentJournalItemKey(echo)
      }
    }
    const lifecycle: AgentJournalTurnLifecycle = {
      turnId: `turn-${clientMessageId}`,
      state,
      outcome: state === 'completed' ? 'success' : undefined,
      userItemId,
      ...(state === 'running' ? {} : { completedAt: 100 })
    }
    await journal.appendItem(
      identity,
      legacy
        ? { kind: 'status', text: 'Done', turnLifecycle: lifecycle }
        : { kind: 'turn', ...lifecycle },
      { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    return agentJournalItemKey(identity)
  }
  const start = () =>
    db.createStartingWorkerDispatch({
      taskSpec: 'real native child work',
      taskRunId: run.id,
      taskCreatedByRunGeneration: run.consumer_generation,
      startOptions: {},
      creator: { kind: 'session', orcaSessionId: root },
      maxDepth: 9
    })
  const finish = (
    child: ReturnType<typeof start>,
    contract: 'legacy_direct' | 'current_delivery' = 'current_delivery'
  ) =>
    db.commitWorkerDoneMessageMutation(() => {
      db.completeDispatch(child.dispatch.id)
      return db.insertMessage({
        from: 'structworker_e7f53907-0cde-40b9-81c5-d18eb66c07a4',
        to: `run:${run.id}`,
        runId: run.id,
        type: 'worker_done',
        subject: 'child completed',
        payload: JSON.stringify({
          dispatchId: child.dispatch.id,
          taskId: child.task.id,
          outcome: 'succeeded'
        }),
        deliveryContract: contract
      })
    })
  const body = (message: ReturnType<typeof finish>) =>
    structuredMailNotice({
      db,
      mailboxHandle: `run:${run.id}`,
      dispatchId: null,
      batch: { messages: [message], heldDeliveryId: undefined },
      cliCommand: 'orca-dev',
      senderName: () => null
    })
  return {
    rig,
    record,
    store,
    session,
    deps,
    journal,
    db,
    run,
    root,
    submit,
    turn,
    start,
    finish,
    body,
    dispose: async () => {
      await journal.close()
      db.close()
      await rig.dispose()
    }
  }
}
