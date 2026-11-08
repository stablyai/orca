import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { beforeEach, expect, it, vi } from 'vitest'
import { track } from '../../telemetry/client'
import { createFixture } from './queued-messages/journal-unsent-send-hold-contract-test-fixture'
import type { AgentSessionJournal } from './journal-store'
import type { AgentSessionChatAction } from '../../../shared/agent-session/journal/agent-session-chat-action'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { openTestJournalHostDatabase } from './store-lifecycle/journal-host-database-test-support'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
const fixture = createFixture({ legacyInputs: false })
beforeEach(() => {
  vi.mocked(track).mockClear()
  fixture.IDENTITY.hostId = 'runtime:host-fixture'
})
const accept = (clientMessageId = 'send-1') => ({
  clientMessageId,
  fence: 0,
  state: 'accepted' as const,
  providerIdentity: { provider: 'claude' as const, sessionId: 'native-1', uuid: clientMessageId }
})
async function submit(journal: AgentSessionJournal, chatAction?: AgentSessionChatAction) {
  const body = fixture.message('private human text')
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    body,
    payloadFingerprint: fixture.fingerprint(body),
    fence: 0,
    handoverRecorded: true,
    chatAction
  })
  await journal.resolveDispatch({
    clientMessageId: 'send-1',
    state: 'pending',
    fence: 0,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

it('emits once after committed acceptance, never on admission, replay, or reopening', async () => {
  let journal = await fixture.open()
  await submit(journal, 'message')
  expect(track).not.toHaveBeenCalled()
  await Promise.all([
    journal.resolveDispatch(accept()),
    journal.resolveDispatch(accept()),
    journal.acceptLate(accept())
  ])
  expect(track).toHaveBeenCalledExactlyOnceWith('native_chat_message_sent', {
    semantics_version: 2,
    client: 'desktop',
    action: 'message',
    backend: 'structured',
    outcome: 'transport_acknowledged',
    agent_kind: 'claude-code',
    runtime: 'remote'
  })
  await journal.close()
  journal = await fixture.open()
  expect(journal.submission('send-1')?.chatAction).toBe('message')
  await journal.acceptLate(accept())
  expect(track).toHaveBeenCalledOnce()
})

it('preserves uncertain delivery and its action through reconnect, then counts only a late acknowledgement', async () => {
  let journal = await fixture.open()
  await submit(journal, 'message')
  await journal.resolveDispatch({
    clientMessageId: 'send-1',
    fence: 0,
    state: 'unknown',
    reason: 'lost acknowledgment'
  })
  expect(track).not.toHaveBeenCalled()
  await journal.close()
  journal = await fixture.open()
  expect(journal.submission('send-1')).toMatchObject({
    chatAction: 'message',
    dispatchState: 'unknown'
  })
  expect(track).not.toHaveBeenCalled()
  await journal.acceptLate(accept())
  await journal.acceptLate(accept())
  expect(track).toHaveBeenCalledOnce()
})

it.each(['command', 'continue', undefined] as const)(
  'never counts %s as an acknowledged human message',
  async (action) => {
    const journal = await fixture.open()
    await submit(journal, action)
    await journal.resolveDispatch(accept())
    expect(track).not.toHaveBeenCalled()
  }
)

it('refusal is terminal and cannot turn a later receipt into successful work', async () => {
  const journal = await fixture.open()
  await submit(journal, 'message')
  await journal.resolveDispatch({
    clientMessageId: 'send-1',
    fence: 0,
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
      surface: 'rejection'
    })
  })
  await journal.acceptLate(accept())
  expect(journal.submission('send-1')?.dispatchState).toBe('rejected')
  expect(track).toHaveBeenCalledExactlyOnceWith(
    'native_chat_message_sent',
    expect.objectContaining({ outcome: 'rejected' })
  )
})

it('emits nothing when settlement rolls back, then emits once on committed retry', async () => {
  const journal = await fixture.open()
  await submit(journal, 'message')
  const transaction = vi.spyOn(openTestJournalHostDatabase(fixture.root), 'transaction')
  transaction.mockImplementationOnce(() => {
    throw new Error('commit failed')
  })
  await expect(journal.resolveDispatch(accept())).rejects.toThrow('commit failed')
  expect(track).not.toHaveBeenCalled()
  expect(journal.submission('send-1')?.dispatchState).toBe('pending')
  await journal.resolveDispatch(accept())
  expect(track).toHaveBeenCalledOnce()
  transaction.mockRestore()
})

it('never lets a telemetry failure change the committed dispatch result', async () => {
  const journal = await fixture.open()
  await submit(journal, 'message')
  vi.mocked(track).mockImplementationOnce(() => {
    throw new Error('telemetry unavailable')
  })
  await journal.resolveDispatch(accept())
  expect(journal.submission('send-1')?.dispatchState).toBe('accepted')
  await journal.acceptLate(accept())
  expect(track).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'does not count a rejection folded to unknown (with card plan: %s)',
  async (withCards) => {
    let journal = await fixture.open()
    const card = await journal.queuedMessages.insert({
      messageId: 'card-1',
      body: fixture.message('queued human message'),
      chatAction: 'message'
    })
    await journal.appendSubmission(
      {
        clientMessageId: 'send-1',
        body: card.body,
        payloadFingerprint: card.fingerprint,
        fence: 0,
        handoverRecorded: true,
        chatAction: 'message'
      },
      { messageId: card.messageId, expect: 'waiting' }
    )
    await journal.resolveDispatch({
      clientMessageId: 'send-1',
      fence: 0,
      state: 'pending',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.resolveDispatch(
      {
        clientMessageId: 'send-1',
        fence: 0,
        state: 'rejected',
        ...fixture.HOST_RESTARTED
      },
      withCards ? () => journal.queuedMessages.plan([]) : undefined
    )
    expect(journal.submission('send-1')?.dispatchState).toBe('unknown')
    expect(journal.queuedMessages.get(card.messageId)?.state).toBe('dispatched')
    expect(track).not.toHaveBeenCalled()
    await journal.close()
    journal = await fixture.open()
    expect(journal.submission('send-1')?.dispatchState).toBe('unknown')
    expect(track).not.toHaveBeenCalled()
    await journal.acceptLate(accept())
    await journal.acceptLate(accept())
    expect(journal.submission('send-1')?.dispatchState).toBe('accepted')
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'native_chat_message_sent',
      expect.objectContaining({ outcome: 'transport_acknowledged' })
    )
  }
)

it.each(['item', 'batch'] as const)(
  'counts a provider %s echo after failed settlement, without recounting a receipt',
  async (kind) => {
    const journal = await fixture.open()
    await submit(journal, 'message')
    const transaction = vi.spyOn(openTestJournalHostDatabase(fixture.root), 'transaction')
    transaction.mockImplementationOnce(() => {
      throw new Error('commit failed')
    })
    await expect(journal.acceptLate(accept())).rejects.toThrow('commit failed')
    expect(track).not.toHaveBeenCalled()
    const identity = { provider: 'claude' as const, sessionId: 'native-1', uuid: 'echo-1' }
    const body = fixture.message('private human text')
    await (kind === 'item'
      ? journal.appendItem(identity, body, { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
      : journal.appendLifecycleBatch({
          settlementId: 'echo-batch',
          fence: 0,
          mutations: [{ kind: 'item', identity, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE }]
        }))
    expect(journal.submission('send-1')?.dispatchState).toBe('accepted')
    await journal.acceptLate(accept())
    await journal.resolveDispatch(accept())
    expect(track).toHaveBeenCalledExactlyOnceWith('native_chat_message_sent', {
      semantics_version: 2,
      client: 'desktop',
      action: 'message',
      backend: 'structured',
      outcome: 'transport_acknowledged',
      agent_kind: 'claude-code',
      runtime: 'remote'
    })
    transaction.mockRestore()
  }
)
