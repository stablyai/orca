import { afterEach, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { PI_RPC_AGENT } from '../../../../pi/rpc-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../../../codex/structured/launch/codex-structured-agent-definition'
import { structuredAgentsDeclaringNothing } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

const piSelection = {
  sessionId: SESSION,
  agent: 'pi',
  consent: { from: 'codex', fromPermission: 'ask', permission: 'full-access' }
} as const

const piHost = {
  agents: structuredAgentsDeclaringNothing([CODEX_STRUCTURED_AGENT, PI_RPC_AGENT]),
  resolveProviderSwitchAccount: async () => ({
    variable: 'PI_CODING_AGENT_DIR' as const,
    path: '/test/pi'
  })
}

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

  expect(
    await chat.host.selectProvider({
      sessionId: SESSION,
      agent: 'claude',
      options: { effort: 'low' }
    })
  ).toEqual({ status: 'selected' })
  const second = await chat.send('Add the shortcut to the note', 'queue-if-active').result
  if (!second.ok || !('queued' in second.value)) {
    throw new Error('Expected the second message to wait in the queue')
  }
  const queued = second.value.queued.messageId
  const third = await chat.send('Now update the changelog', 'queue-if-active', {
    carried: { effort: 'high' }
  }).result
  if (!third.ok || !('queued' in third.value)) {
    throw new Error('Expected the third message to wait behind the second')
  }
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
  expect(chat.dispatch.mock.calls.at(-1)?.[0].executionOptions).toEqual({ effort: 'low' })
  await chat.host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: handoffId,
    providerIdentity: { provider: 'legacy', agent: 'claude', sessionId: THREAD, recordId: 'second' }
  })
  await eventually(async () => {
    expect((await chat.handoff(third.value.queued.messageId))?.handedOverAt).toBeDefined()
    expect(chat.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
      body: { blocks: [{ type: 'text', text: 'Now update the changelog' }] },
      executionOptions: { effort: 'low' }
    })
  })
})

it('delivers the first prose after a switched command receives its late receipt', async () => {
  const chat = await createQueuedMessageTestRig({
    agent: 'claude',
    restartable: true,
    hostDeps: {
      resolveProviderSwitchAccount: async () => ({ variable: 'CODEX_HOME', path: '/test/codex' })
    }
  })
  rig = chat
  expect(await chat.host.selectProvider({ sessionId: SESSION, agent: 'codex' })).toEqual({
    status: 'selected'
  })
  const command = chat.send('/status')
  expect(await command.result).toMatchObject({ ok: true })
  await eventually(async () =>
    expect((await chat.submission(command.id))?.handedOverAt).toBeDefined()
  )
  expect(chat.dispatch.mock.calls[0]?.[0].body.blocks).toEqual([{ type: 'text', text: '/status' }])
  await chat.settleAccepted(command.id, 'command')
  expect(chat.store.getRecord(SESSION)?.providerSwitch?.clientMessageId).toBe(command.id)

  const prose = chat.send('Summarize the saved work', undefined, {
    fence: chat.store.getRecord(SESSION)!.lease.runtimeFence
  })
  expect(await prose.result).toMatchObject({ ok: true })
  await eventually(() => {
    expect(chat.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
      clientMessageId: prose.id,
      body: {
        blocks: [
          { type: 'text', text: expect.stringContaining('[user] /status') },
          { type: 'text', text: 'Summarize the saved work' }
        ]
      }
    })
  })
})

it('requires fresh consent after the host restarts before the first switched turn', async () => {
  const chat = await createQueuedMessageTestRig({ hostDeps: piHost })
  rig = chat
  const pick = { sessionId: SESSION, agent: 'pi' }
  const required = { status: 'consent-required', from: 'codex', fromPermission: 'ask' }
  expect(await chat.host.selectProvider(pick)).toEqual(required)
  expect(await chat.host.selectProvider(piSelection)).toEqual({ status: 'selected' })

  await chat.quitRestartHostProcess()
  expect(await chat.host.selectProvider(pick)).toEqual(required)
  const { id, result } = chat.send('Read the note')
  await result
  await eventually(async () => {
    expect((await chat.submission(id))?.dispatchState).toBe('rejected')
  })
  expect(chat.store.getRecord(SESSION)?.provider).toBe('codex')
  expect(chat.dispatch).not.toHaveBeenCalled()
})

it('leaves a failed Home Chat handoff pending and requires fresh consent', async () => {
  const chat = await createQueuedMessageTestRig({
    hostDeps: { ...piHost, botHomeDefault: () => 'pi' }
  })
  rig = chat
  expect(
    await chat.host.selectProvider(piSelection, { botId: 'builder', save: async () => {} })
  ).toEqual({ status: 'selected' })
  chat.failNextStart(new Error('Pi start failed'))
  const { id, result } = chat.send('Write the test')
  await result
  await eventually(async () => {
    expect((await chat.submission(id))?.dispatchState).toBe('rejected')
    expect(chat.store.getRecord(SESSION)).toMatchObject({
      provider: 'codex',
      selectedProvider: {
        agent: 'pi',
        botDefault: 'builder'
      }
    })
  })
  const starts = chat.starts.mock.calls.length
  const { id: retry, result: sent } = chat.send('Write the test again', undefined, {
    fence: chat.store.getRecord(SESSION)!.lease.runtimeFence
  })
  await sent
  await eventually(async () =>
    expect((await chat.submission(retry))?.rejection).toMatchObject({
      kind: 'providerSwitchConsentRequired'
    })
  )
  expect(chat.starts).toHaveBeenCalledTimes(starts)
  expect(chat.dispatch).not.toHaveBeenCalled()
})

it('sends new work after a switch while keeping a held card under its earlier permissions', async () => {
  const chat = await createQueuedMessageTestRig({ hostDeps: piHost, restartable: true })
  rig = chat
  const journal = (await chat.host.conversation(SESSION)).journal
  const old = await journal.queuedMessages.insert({
    messageId: 'held-before-consent',
    body: hostTestMessage('Review the private notes'),
    holdReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
  })
  expect(await chat.host.selectProvider(piSelection)).toEqual({ status: 'selected' })
  chat.dispatch.mockResolvedValueOnce({
    state: 'accepted',
    providerIdentity: { provider: 'legacy', agent: 'pi', sessionId: THREAD, recordId: 'answer' }
  })
  const { id, result } = chat.send('Write the test')
  await result
  await eventually(async () => {
    expect((await chat.submission(id))?.dispatchState).toBe('accepted')
    expect(chat.store.getRecord(SESSION)?.provider).toBe('pi')
    expect(chat.store.getRecord(SESSION)?.providerSwitch).toBeUndefined()
  })
  const messageId = old.messageId
  const sent = await chat.host.queuedMessageSend(QUEUED_RIG_CALLER, {
    messageId,
    envelope: {
      ...chat.envelope({ messageId }, 'agentSession.queuedMessageSend', hostTestOperationId()),
      expectedRuntimeFence: chat.store.getRecord(SESSION)!.lease.runtimeFence
    }
  })
  expect(sent).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await journal.queuedMessages.get(messageId)).toMatchObject({
      state: 'returned',
      returnedRejection: { kind: 'providerSwitchQueuedPermission' }
    })
  )
  expect(chat.dispatch).toHaveBeenCalledTimes(1)
})
