import { afterEach, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(() => rig?.dispose())

it('finishes the current reply before carrying its history into the next agent on the same chat', async () => {
  const chat = await createQueuedMessageTestRig({
    restartable: true,
    hostDeps: {
      resolveProviderSwitchAccount: async () => ({
        variable: 'CLAUDE_CONFIG_DIR',
        path: '/test/claude'
      })
    }
  })
  rig = chat
  const first = await chat.workingSend()
  await chat.settleAccepted(first, 'first')
  const journal = (await chat.host.conversation(SESSION)).journal
  const firstTurn = { provider: 'codex' as const, threadId: THREAD, turnId: 'first', ordinal: 0 }
  const turn = {
    kind: 'turn' as const,
    turnId: 'first',
    startedAt: HOST_TEST_NOW,
    userItemId: agentJournalSubmissionKey(first)
  }
  await journal.appendItem(
    firstTurn,
    { ...turn, state: 'running' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )

  expect(await chat.host.selectProvider({ sessionId: SESSION, agent: 'claude' })).toEqual({
    status: 'selected'
  })
  const second = await chat.send('Add the shortcut to the note', 'queue-if-active').result
  if (!second.ok || !('queued' in second.value)) {
    throw new Error('Expected the second message to wait in the queue')
  }
  const queued = second.value.queued.messageId
  expect(chat.store.getRecord(SESSION)).toMatchObject({
    provider: 'codex',
    selectedProvider: { agent: 'claude' }
  })
  expect(await chat.handoff(queued)).toBeUndefined()

  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'old-provider-reply' },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The existing shortcut is Control+Shift+N.' }]
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(firstTurn) } }
  )
  await journal.appendItem(
    firstTurn,
    {
      ...turn,
      state: 'completed',
      outcome: 'success',
      completedAt: HOST_TEST_NOW + 1
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )

  await eventually(async () => {
    expect((await chat.handoff(queued))?.handedOverAt).toBeDefined()
    expect(
      chat.store.getRecord(SESSION)?.providerHandleChain.map(({ handle }) => handle.agent)
    ).toEqual(['codex', 'claude'])
  })
  const sent = chat.dispatch.mock.calls.at(-1)?.[0].body
  expect(sent?.blocks).toEqual([
    { type: 'text', text: expect.stringContaining('The existing shortcut is Control+Shift+N.') },
    { type: 'text', text: 'Add the shortcut to the note' }
  ])
  const handoffId = await chat.handoffId(queued)
  const saved = await journal.reads.itemBody(agentJournalSubmissionKey(handoffId))
  expect(saved).toMatchObject({ blocks: [{ type: 'text', text: 'Add the shortcut to the note' }] })
})
