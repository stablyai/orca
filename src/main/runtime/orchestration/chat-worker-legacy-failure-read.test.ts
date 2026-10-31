import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { openTestJournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionJournalProjections } from '../../native-chat/agent-session-wire/structured-agent-session-status-journal-projection'
import { hostTestMessage } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  SESSION,
  journals,
  tick,
  rig,
  mutation,
  words,
  batch
} from './chat-worker-request-failure-rig.test-fixture'
import {
  countLegacyFailureDisplay,
  emptyLegacyCounts
} from './chat-worker-legacy-operation-counts.test-support'

it.each([100, 1000])(
  'bounds the added failure display with %i readable legacy cards',
  async (n) => {
    const r = await rig()
    r.sessions.delete(SESSION)
    const body = hostTestMessage('saved handoff')
    const fingerprint = agentSessionSendBodyFingerprint(SESSION, body)
    const cancelled = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
      surface: 'rejection'
    })
    for (let index = 0; index < n; index++) {
      const clientMessageId = `legacy:${index}`
      await r.journal.appendSubmission({
        clientMessageId,
        payloadFingerprint: fingerprint,
        body,
        fence: 0,
        handoverRecorded: true,
        queuedMessageId: `card:${index}`
      })
      await r.journal.resolveDispatch({
        clientMessageId,
        state: 'pending',
        fence: 0,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await r.journal.resolveDispatch({
        clientMessageId,
        state: 'rejected',
        ...cancelled,
        fence: 0
      })
    }
    await r.journal.close()
    const db = openTestJournalHostDatabase(r.root).db
    const insert = db.prepare(`INSERT INTO queued_messages
    (session_id, message_id, position, body_json, fingerprint, created_at, host_instance,
     state, hold_reason, returned_reason, consumed_as)
    VALUES (?, ?, ?, ?, ?, 0, 'earlier', 'dispatched', NULL, NULL, ?)`)
    for (let index = 0; index < n; index++) {
      insert.run(
        SESSION,
        `card:${index}`,
        index,
        JSON.stringify(body),
        fingerprint,
        `legacy:${index}`
      )
    }
    db.exec(`CREATE TEMP TRIGGER fail_import BEFORE DELETE ON queued_messages
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ops = countLegacyFailureDisplay()
    const journal = await journals.open({
      stateDirectory: r.root,
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      }
    })
    expect(warned).toHaveBeenCalledExactlyOnceWith(
      '[journal-open] queued-message import skipped:',
      { sessionId: SESSION, error: 'disk full' }
    )
    expect(
      db.prepare('SELECT message_id FROM queued_messages WHERE session_id = ?').all(SESSION)
    ).toHaveLength(n)
    expect(journal.queuedMessages.list()).toHaveLength(n)
    const cold = structuredClone(ops.counts)
    // Three decoded populations: restore, cached source and failed import. The import builds
    // N queue rows on an isolated draft before its DELETE fails; none of that work is free.
    expect(cold).toEqual({
      upstream: {
        ...emptyLegacyCounts(),
        decodedRows: 3 * n,
        restoredRows: n,
        ownerClassifications: 2 * n,
        cardConstructions: 5 * n,
        handoffVisits: n,
        identityEntries: n,
        sourceIdEntries: n,
        overlayEntries: 2 * n,
        overlayVisits: 2 * n,
        priorOverlayVisits: n,
        indexUpdates: 4 * n,
        overlayIndexUpdates: 2 * n,
        pointIndexUpdates: 2 * n,
        indexRebuilds: 1
      },
      publication: emptyLegacyCounts(),
      failure: emptyLegacyCounts()
    })
    ops.reset()
    const projection = new StructuredAgentSessionJournalProjections()
    r.deliver.mockImplementation(() => ops.publication(() => projection.read(journal, null)))
    r.sessions.set(SESSION, { ...r.session, journal })
    await journal.appendSubmission({
      clientMessageId: 'eligible',
      payloadFingerprint: 'eligible',
      body: hostTestMessage('fail'),
      fence: 0
    })
    await batch(journal, 'eligible-running', [
      mutation('eligible-turn', {
        kind: 'turn',
        turnId: 'eligible-turn',
        state: 'running',
        userItemId: agentJournalSubmissionKey('eligible')
      })
    ])
    await tick()
    const changed = structuredClone(ops.counts)
    // First successful native introduction charges N point updates, without reclassification.
    expect(changed).toEqual({
      upstream: { ...emptyLegacyCounts(), indexUpdates: n, pointIndexUpdates: n },
      publication: {
        ...emptyLegacyCounts(),
        displays: 2,
        handoffApplications: 2 * n,
        itemCopies: 2,
        itemEntries: 2 * n + 3,
        submissionCopies: 2,
        submissionEntries: 2 * (n + 1)
      },
      failure: emptyLegacyCounts()
    })
    expect(r.deliver).toHaveBeenCalledTimes(2)
    ops.reset()
    r.deliver.mockClear()
    await batch(journal, 'ordinary-output', [
      mutation(
        'ordinary-output',
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'ordinary output' }]
        },
        'eligible-turn'
      )
    ])
    await tick()
    const ordinary = structuredClone(ops.counts)
    expect(ordinary).toEqual({
      upstream: emptyLegacyCounts(),
      publication: {
        ...emptyLegacyCounts(),
        displays: 1,
        handoffApplications: n,
        itemCopies: 1,
        itemEntries: n + 3,
        submissionCopies: 1,
        submissionEntries: n + 1
      },
      failure: emptyLegacyCounts()
    })
    expect(r.deliver).toHaveBeenCalledTimes(1)
    expect(r.mail()).toHaveLength(0)
    ops.reset()
    r.deliver.mockClear()
    await batch(journal, 'eligible-failure', [
      mutation('eligible-turn', {
        kind: 'turn',
        turnId: 'eligible-turn',
        state: 'completed',
        outcome: 'failure',
        userItemId: agentJournalSubmissionKey('eligible')
      }),
      words('eligible-turn', 'exact legacy failure')
    ])
    await tick()
    const failure = structuredClone(ops.counts)
    const oneDisplay = {
      ...emptyLegacyCounts(),
      displays: 1,
      handoffApplications: n,
      itemCopies: 1,
      itemEntries: n + 4,
      submissionCopies: 1,
      submissionEntries: n + 1
    }
    expect(failure).toEqual({
      upstream: emptyLegacyCounts(),
      publication: oneDisplay,
      failure: {
        ...emptyLegacyCounts(),
        displays: 1,
        itemCopies: 0,
        itemEntries: 0,
        submissionCopies: 0,
        submissionEntries: 0
      }
    })
    expect(r.deliver).toHaveBeenCalledTimes(1)
    expect(r.mail()).toHaveLength(1)
    expect(r.mail()[0]?.body).toBe(
      [
        `Worker ${formatOrcaSessionAddress(SESSION)} hit an error while running task "work" (${r.dispatch().task_id}).`,
        'Error: exact legacy failure',
        'The task is still assigned to this chat, which keeps its history.'
      ].join('\n')
    )
    expect(r.db.getDispatchContextById(r.dispatch().id)?.status).toBe('dispatched')
    expect(r.db.getTask(r.dispatch().task_id)?.status).toBe('dispatched')
    expect(journal.submission('legacy:0')?.dispatchState).toBe('rejected')
    process.stdout.write(
      `LEGACY_FAILURE_OPERATIONS ${JSON.stringify({ n, cold, changed, ordinary, failure })}\n`
    )
  }
)
