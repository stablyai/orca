import { createHash } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
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
import { agentSessionContextSnapshotRoot } from '../../../conversation-context/agent-session-context-snapshots'
import { completeTestJournalRewind } from '../../rewind/structured-rewind-completion.test-support'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionProviderHandleLink } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'

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

it.each(['first Codex', 'return to Codex', 'return to Claude'])(
  'recovers a native rewind with switch history (%s)',
  async (scenario) => {
    const returns = scenario !== 'first Codex'
    const forks = scenario === 'return to Claude'
    const chat = await createQueuedMessageTestRig(forks ? { agent: 'claude' } : {})
    rig = chat
    const { journal } = await chat.host.conversation(SESSION)
    const user = forks
      ? { provider: 'claude' as const, sessionId: THREAD, uuid: 'discarded' }
      : { provider: 'codex' as const, threadId: THREAD, turnId: 'discarded', ordinal: 0 }
    await journal.appendItem(user, hostTestMessage('Discard this work'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const itemId = agentJournalItemKey(user)
    const before = await journal.reads.cursor()
    const initial: AgentSessionProviderHandleLink = {
      linkId: 'first',
      handle: forks ? claudeProviderHandle(THREAD, null) : codexProviderHandle(THREAD),
      origin: 'created',
      mintedAtFence: 0,
      observedAt: 0
    }
    const inactive: AgentSessionProviderHandleLink = {
      linkId: 'inactive',
      handle: forks ? codexProviderHandle('retained') : claudeProviderHandle('retained', null),
      origin: 'created',
      mintedAtFence: returns ? 1 : 0,
      observedAt: 1,
      ...(returns ? { switchedFrom: initial.linkId } : {})
    }
    const active: AgentSessionProviderHandleLink = {
      ...initial,
      linkId: 'current',
      origin: returns ? 'resumed' : 'created',
      mintedAtFence: returns ? 2 : 1,
      observedAt: 2,
      switchedFrom: inactive.linkId,
      switchedBy: 'handoff-send'
    }
    const chain = [...(returns ? [initial] : []), inactive, active]
    const { record, outcome } = await completeTestJournalRewind(
      chat.root,
      journal,
      itemId,
      active.mintedAtFence,
      chain
    )
    expect(record?.rewind?.phase).toBe('completed')
    expect(
      record?.providerHandleChain.map(({ linkId, switchedFrom }) => [linkId, switchedFrom])
    ).toEqual([
      ...(returns ? [['first', undefined]] : []),
      ['current', undefined],
      ...(forks ? [['rewind-fixture-fork', undefined]] : [])
    ])
    expect(await journal.reads.itemBody(itemId)).toBeNull()
    const { epoch } = await journal.reads.cursor()
    expect(epoch).not.toBe(before.epoch)
    expect(outcome).toMatchObject({ status: 'succeeded', rewind: { itemId, epoch } })
  }
)

it('keeps an identical pending provider option from publishing another record', async () => {
  let now = HOST_TEST_NOW
  const chat = await createQueuedMessageTestRig({
    now: () => now,
    hostDeps: {
      resolveProviderSwitchAccount: async () => ({
        variable: 'CLAUDE_CONFIG_DIR',
        path: '/test/claude'
      })
    }
  })
  rig = chat
  const choose = (effort: string) =>
    chat.host.selectProvider({ sessionId: SESSION, agent: 'claude', options: { effort } })
  expect(await choose('low')).toEqual({ status: 'selected' })
  const previous = chat.store.recordStamp(SESSION)
  const changes: string[] = []
  const release = chat.store.onRecordsChanged((ids) => changes.push(...ids))
  try {
    now++
    expect(await choose('low')).toEqual({ status: 'selected' })
    expect(chat.store.recordStamp(SESSION)).toBe(previous)
    expect(changes).toEqual([])
    expect(await choose('high')).toEqual({ status: 'selected' })
    expect(chat.store.getRecord(SESSION)?.selectedProvider?.options).toEqual({ effort: 'high' })
    expect(changes).toEqual([SESSION])
  } finally {
    release()
  }
})

it('accepts Stop while a switched send is extracting a spill and never dispatches that send', async () => {
  const chat = await createQueuedMessageTestRig({
    agent: 'claude',
    restartable: true,
    hostDeps: {
      resolveProviderSwitchAccount: async () => ({
        variable: 'CODEX_HOME',
        path: '/test/codex'
      })
    }
  })
  rig = chat
  const { journal } = await chat.host.conversation(SESSION)
  const stateDirectory = chat.host.deps.journalDatabase.stateDirectory
  const root = agentSessionContextSnapshotRoot(stateDirectory)
  const output = 'saved tool output '.repeat(8_192)
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'large-tool-output' },
    {
      kind: 'tool-call',
      name: 'shell',
      input: {},
      state: 'completed',
      output: {
        head: output,
        byteLength: output.length,
        truncated: false,
        digest: createHash('sha256').update(output).digest('hex')
      }
    },
    {
      fence: chat.store.getRecord(SESSION)!.lease.runtimeFence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  const entered = Promise.withResolvers<AbortSignal | undefined>()
  const releaseSpill = Promise.withResolvers<void>()
  const extract = journal.reads.continuationSpill
  const spill = vi
    .spyOn(journal.reads, 'continuationSpill')
    .mockImplementation(async (part, signal) => {
      entered.resolve(signal)
      await releaseSpill.promise
      return extract(part, signal)
    })
  try {
    expect(await chat.host.selectProvider({ sessionId: SESSION, agent: 'codex' })).toEqual({
      status: 'selected'
    })
    const send = chat.send('Use the saved output')
    expect(await send.result).toMatchObject({ ok: true })
    const signal = await entered.promise
    expect(signal?.aborted).toBe(false)
    const fence = chat.store.getRecord(SESSION)!.lease.runtimeFence
    const later = chat.send('Follow up', 'queue-if-active', { fence })
    expect(await later.result).toMatchObject({ ok: true })
    const operationId = hostTestOperationId()
    const stop = chat.host.cancel(QUEUED_RIG_CALLER, {
      envelope: {
        ...chat.envelope({}, 'agentSession.cancel', operationId),
        expectedRuntimeFence: fence
      }
    })
    expect(await stop).toMatchObject({ ok: true })
    expect(signal?.aborted).toBe(true)
    releaseSpill.resolve()
    await eventually(async () => {
      expect(chat.store.getRecord(SESSION)?.providerSwitch).toBeUndefined()
      expect((await chat.submission(send.id))?.dispatchState).toBe('rejected')
    })
    expect(chat.dispatch.mock.calls.map(([input]) => input.clientMessageId)).not.toContain(send.id)
    expect((await readdir(root)).filter((file) => file !== 'spills')).toEqual([])
  } finally {
    releaseSpill.resolve()
    spill.mockRestore()
    await chat.host.flushAllStreamedEvents()
    await rm(root, { recursive: true, force: true })
  }
})

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
  const laterQueued = third.value.queued.messageId
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
  const context = sent?.blocks[0]
  if (context?.type !== 'text') {
    throw new Error('Expected the prior chat context')
  }
  expect(context.text).not.toContain('Add the shortcut to the note')
  expect(context.text).not.toContain('Now update the changelog')
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
    expect((await chat.handoff(laterQueued))?.handedOverAt).toBeDefined()
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

it('keeps pre-consent room reservations on their old authority and refuses late ones after switch', async () => {
  const preConsentIds = new Set<string>()
  const chat = await createQueuedMessageTestRig({
    hostDeps: {
      ...piHost,
      isPreConsentOperation: (_sessionId, clientMessageId) => preConsentIds.has(clientMessageId)
    }
  })
  rig = chat
  expect(await chat.host.selectProvider(piSelection)).toEqual({ status: 'selected' })

  chat.dispatch.mockResolvedValueOnce({
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-old-1', ordinal: 1 }
  })
  const early = chat.send('Reserved before consent')
  preConsentIds.add(early.id)
  await early.result
  await eventually(async () => {
    expect((await chat.submission(early.id))?.dispatchState).toBe('accepted')
  })
  expect(chat.store.getRecord(SESSION)?.provider).toBe('codex')
  expect(chat.store.getRecord(SESSION)?.selectedProvider?.agent).toBe('pi')

  chat.dispatch.mockResolvedValueOnce({
    state: 'accepted',
    providerIdentity: { provider: 'legacy', agent: 'pi', sessionId: THREAD, recordId: 'new-1' }
  })
  const after = chat.send('Sent after consent', undefined, {
    fence: chat.store.getRecord(SESSION)!.lease.runtimeFence
  })
  await after.result
  await eventually(async () => {
    expect((await chat.submission(after.id))?.dispatchState).toBe('accepted')
    expect(chat.store.getRecord(SESSION)?.provider).toBe('pi')
    expect(chat.store.getRecord(SESSION)?.providerSwitch).toBeUndefined()
  })

  const late = chat.send('Late pre-consent reservation', undefined, {
    fence: chat.store.getRecord(SESSION)!.lease.runtimeFence
  })
  preConsentIds.add(late.id)
  await late.result
  await eventually(async () => {
    expect((await chat.submission(late.id))?.rejection).toMatchObject({
      kind: 'providerSwitchQueuedPermission'
    })
  })
  expect(chat.dispatch).toHaveBeenCalledTimes(2)
})
