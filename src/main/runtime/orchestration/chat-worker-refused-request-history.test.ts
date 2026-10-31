import { expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { hostTestMessage } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { buildJournalTombstoneRow } from '../../native-chat/agent-session-journal/journal-row-builders'
import {
  SESSION,
  batch,
  mutation,
  rig,
  tick,
  turn,
  registerScopedRequestFailureOwnership
} from './chat-worker-request-failure-rig.test-fixture'

registerScopedRequestFailureOwnership()
const refusal = () =>
  agentSessionFailureWords({ kind: 'cliMissing' }, { surface: 'rejection', agentName: 'Codex' })

it('accounts a real queued handoff only after its definitive refusal, never its normalized uncertainty or ignored tails', async () => {
  const r = await rig()
  const body = hostTestMessage('queued work')
  await r.journal.queuedMessages.insert({ messageId: 'draft', body })
  await r.journal.appendSubmission(
    {
      clientMessageId: 'handoff',
      payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body),
      body,
      fence: 0,
      handoverRecorded: true
    },
    { messageId: 'draft', expect: 'waiting' }
  )
  expect(r.journal.submission('handoff')?.queuedMessageId).toBe('draft')
  const admitted = r.journal.submission('handoff')!.submittedSequence
  await r.journal.resolveDispatch({
    clientMessageId: 'handoff',
    fence: 0,
    state: 'pending',
    turnScope: { kind: 'thread' }
  })
  expect(r.journal.item(agentJournalSubmissionKey('handoff'))!.sequence).toBeGreaterThan(admitted!)
  await r.journal.resolveDispatch({
    clientMessageId: 'handoff',
    fence: 0,
    state: 'rejected',
    ...agentSessionFailureWords({ kind: 'hostRestarted' }, { surface: 'rejection' }),
    recovered: true
  })
  expect(r.journal.submission('handoff')?.dispatchState).toBe('unknown')
  expect(r.journal.queuedMessages.get('draft')).toMatchObject({
    state: 'dispatched',
    consumedAs: 'handoff'
  })
  await tick()
  expect(r.failures).not.toHaveBeenCalled()
  expect(r.mail()).toHaveLength(0)
  await r.journal.resolveDispatch({
    clientMessageId: 'handoff',
    fence: 0,
    state: 'rejected',
    ...refusal()
  })
  // The callback is synchronous with this commit; no output/timer/person action releases it.
  expect(
    r.failures.mock.calls.map(([f]) => ({ kind: f.kind, id: f.id, outcome: f.outcome }))
  ).toEqual([{ kind: 'refused-send', id: 'orca:handoff', outcome: 'failure' }])
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(JSON.parse(r.mail()[0]!.payload!)).toMatchObject({
    requestId: 'orca:handoff',
    error: refusal().reason
  })
  expect(r.notify).toHaveBeenCalledOnce()
  const ignoredEcho = {
    provider: 'codex' as const,
    threadId: 'thread-1',
    turnId: 'ignored-echo',
    ordinal: 0
  }
  await r.journal.resolveDispatch({
    clientMessageId: 'handoff',
    fence: 0,
    state: 'accepted',
    providerIdentity: ignoredEcho
  })
  expect(r.journal.receiptFor('handoff')).toBeNull()
  await r.journal.resolveDispatch({
    clientMessageId: 'handoff',
    fence: 0,
    state: 'rejected',
    ...refusal()
  })
  await batch(r.journal, 'tail', [mutation('tail', { kind: 'status', text: 'late output' })])
  await r.journal.queuedMessages.insert({
    messageId: 'later-draft',
    body: hostTestMessage('later')
  })
  await tick()
  expect(r.failures).toHaveBeenCalledOnce()
  expect(r.mail()).toHaveLength(1)
  expect(r.journal.submissions().filter((s) => s.queuedMessageId === 'draft')).toHaveLength(1)
})

it('distinguishes applied mixed-batch refusal from terminal materialization and preserves later live admission', async () => {
  const r = await rig()
  const admit = async (id: string) =>
    r.journal.appendSubmission({
      clientMessageId: id,
      payloadFingerprint: id,
      body: hostTestMessage(id),
      fence: 0,
      handoverRecorded: true
    })
  const reject = (id: string) =>
    r.journal.resolveDispatch({ clientMessageId: id, fence: 0, state: 'rejected', ...refusal() })
  const identity = (id: string) => ({ provider: 'orca' as const, clientMessageId: id })
  const restore = (id: string) => mutation(agentJournalSubmissionKey(id), hostTestMessage(id))
  const callbacks = () => r.failures.mock.calls.map(([f]) => f.id)

  r.sessions.delete(SESSION)
  await admit('historical')
  await reject('historical')
  r.sessions.set(SESSION, r.session)
  await tick()
  expect(callbacks()).toEqual([])
  await r.journal.appendTombstone(identity('historical'), { fence: 0 })
  expect(r.journal.item('orca:historical')).toBeNull()
  await r.journal.appendItem(identity('historical'), hostTestMessage('historical'), {
    fence: 0,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const historicalItem = r.journal.item('orca:historical')!
  const historicalMark = r.observer['baselines']
    .get(SESSION)!
    .marks.get('refused-send:orca:historical')
  // Inject a stale revision at the real writer/fold boundary; public tombstone writers always mint a new revision.
  await r.journal['rowWriter'].enqueue((seq, ts) => ({
    ...buildJournalTombstoneRow({
      state: r.journal['state'],
      itemId: 'orca:historical',
      seq,
      ts,
      fence: 0
    }),
    revision: historicalItem.revision
  }))
  expect(r.journal.item('orca:historical')).toBe(historicalItem)
  expect(r.observer['baselines'].get(SESSION)!.marks.get('refused-send:orca:historical')).toBe(
    historicalMark
  )
  await r.journal.appendLifecycleBatch({
    settlementId: 'terminal-ignored-mixed',
    fence: 0,
    dispatches: [{ clientMessageId: 'historical', fence: 0, state: 'rejected', ...refusal() }],
    mutations: [{ kind: 'tombstone', itemId: 'orca:historical' }, restore('historical')]
  })
  await tick()
  expect(callbacks()).toEqual([])
  expect(r.mail()).toHaveLength(0)

  await admit('live-mixed')
  await r.journal.resolveDispatch({ clientMessageId: 'live-mixed', fence: 0, state: 'unknown' })
  await r.journal.appendTombstone(identity('live-mixed'), { fence: 0 })
  await r.journal.appendLifecycleBatch({
    settlementId: 'applied-mixed',
    fence: 0,
    dispatches: [{ clientMessageId: 'live-mixed', fence: 0, state: 'rejected', ...refusal() }],
    mutations: [restore('live-mixed')]
  })
  expect(callbacks()).toEqual(['orca:live-mixed'])
  await tick()
  expect(r.mail()).toHaveLength(1)
  expect(r.notify).toHaveBeenCalledOnce()

  await admit('restored-pending')
  await r.journal.appendLifecycleBatch({
    settlementId: 'pending-rematerialization',
    fence: 0,
    mutations: [{ kind: 'tombstone', itemId: 'orca:restored-pending' }, restore('restored-pending')]
  })
  expect(callbacks()).toEqual(['orca:live-mixed'])
  await reject('restored-pending')
  expect(callbacks()).toEqual(['orca:live-mixed', 'orca:restored-pending'])

  // The represented request is the turn, regardless of its bubble's recreation revision.
  await admit('linked')
  await r.journal.appendTombstone(identity('linked'), { fence: 0 })
  const linked = {
    provider: 'codex' as const,
    threadId: 'thread-1',
    turnId: 'linked-root',
    ordinal: 0
  }
  const started = await r.journal.appendItem(
    linked,
    { kind: 'turn', turnId: 'linked-root', state: 'running' },
    { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await r.journal.appendLifecycleBatch({
    settlementId: 'linked-final',
    fence: 0,
    dispatches: [
      {
        clientMessageId: 'linked',
        fence: 0,
        state: 'rejected',
        ...refusal(),
        answeredInTurn: { turn: linked, via: 'start' }
      }
    ],
    mutations: [restore('linked'), turn(started.itemId, 'failure')]
  })
  await tick()
  expect(callbacks()).toEqual(['orca:live-mixed', 'orca:restored-pending', started.itemId])
  expect(new Set(r.mail().map((m) => m.id)).size).toBe(3)

  await r.journal.context.clear(
    { operationId: 'clear-history', afterFence: 0, clearedAt: 1 },
    { write: () => {}, committed: () => {} }
  )
  const floor = r.journal.context.floor()!
  await admit('retired')
  const first = r.journal.submission('retired')!.submittedSequence
  await reject('retired')
  await tick()
  expect(callbacks().at(-1)).toBe('orca:retired')
  const beforeReuse = callbacks().length
  await r.journal.context.rewind(floor, 0, [], () => ({ write: () => {}, committed: () => {} }))
  expect(r.journal.submission('retired')).toBeUndefined()
  await admit('retired')
  expect(r.journal.submission('retired')!.submittedSequence).toBeGreaterThan(first!)
  // Rewind retains the tombstone; materialize an eligible item before this legal later journal admission settles.
  await r.journal.appendItem(identity('retired'), hostTestMessage('retired'), {
    fence: 0,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(r.journal.item('orca:retired')).not.toBeNull()
  await reject('retired')
  expect(callbacks()).toHaveLength(beforeReuse + 1)
  await tick()
  // The raw reused logical request is not a second durable operation; DB uniqueness remains unchanged.
  expect(r.mail().filter((m) => JSON.parse(m.payload!).requestId === 'orca:retired')).toHaveLength(
    1
  )

  await r.journal.replaceEpochItems('handle_forked', 0, [])
  await admit('fresh-operation')
  await reject('fresh-operation')
  await tick()
  expect(callbacks().at(-1)).toBe('orca:fresh-operation')
  expect(
    r.mail().filter((m) => JSON.parse(m.payload!).requestId === 'orca:fresh-operation')
  ).toHaveLength(1)
  expect(r.notify).toHaveBeenCalledTimes(r.mail().length)
})
