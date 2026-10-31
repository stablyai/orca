import { expect, it, vi } from 'vitest'
import { setup, listen, complete, ownedSend } from './automation-chat-notification-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { eventually } from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
it.each([undefined, 'claude'] as const)(
  'classifies the actual provider identity once before fanout, with later human turns generic (%s)',
  async (agent) => {
    const rig = await setup(agent)
    const listener = listen(rig)
    const own = await ownedSend(rig, 'run')
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
    const owner = rig.host.automationChatInterests
    const classify = vi.spyOn(owner, 'owns')
    const key = await complete(rig, own, 'provider-turn')
    expect(key).not.toBe('provider-turn')
    for (const events of listener.events) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'completion',
          completion: expect.objectContaining({ turnId: 'provider-turn', automationOwned: true })
        })
      )
    }
    expect(classify).toHaveBeenCalledOnce()
    expect(listener.phone).not.toHaveBeenCalled()
    // A final observer is not a claim lifetime; a later human has a different causal root.
    const human = rig.send('human')
    await human.result
    await complete(rig, human.id, 'later-human')
    expect(listener.phone).toHaveBeenCalledOnce()
    expect(listener.events[0].findLast((event) => event.type === 'completion')).toMatchObject({
      completion: { turnId: 'later-human' }
    })
    expect(listener.events[0].at(-1)).not.toHaveProperty('completion.automationOwned')
    listener.stop()
  }
)

it.each(['success', 'returned', 'withdrawn'] as const)(
  'follows actual queued q→s %s without claiming the preceding or following human turn',
  async (result) => {
    const rig = await setup()
    const listener = listen(rig)
    const human = await rig.workingSend()
    const q = await ownedSend(rig, 'queued-run', true)
    if (result === 'withdrawn') {
      await rig.deleteQueued(q)
      expect(await rig.host.queuedSendAnswer(SESSION, q)).toMatchObject({
        queued: { state: 'withdrawn' }
      })
    }
    await complete(rig, human, 'human-before')
    const beforeAutomation = result === 'withdrawn' ? 1 : 0
    expect(listener.phone).toHaveBeenCalledTimes(beforeAutomation)
    if (result !== 'withdrawn') {
      await eventually(async () => expect(await rig.handoff(q)).toBeDefined())
      const s = await rig.handoffId(q)
      expect(s).not.toBe(q)
      if (result === 'returned') {
        await rig.settleRejected(s, 'provider refused')
        await eventually(async () =>
          expect(await rig.drafts()).toMatchObject([{ messageId: q, state: 'returned' }])
        )
        await rig.deleteQueued(q)
      } else {
        await complete(rig, s, 'automation-root')
        expect(listener.events[0]).toContainEqual(
          expect.objectContaining({
            type: 'completion',
            completion: expect.objectContaining({
              automationOwned: true,
              turnId: 'automation-root'
            })
          })
        )
        expect(
          listener.phone.mock.calls.every(([event]) => {
            expect(typeof event.attentionKey).toBe('string')
            if (typeof event.attentionKey !== 'string') {
              throw new Error('Missing attentionKey')
            }
            return !event.attentionKey.includes('automation-root')
          })
        ).toBe(true)
      }
    }
    const later = rig.send('human after')
    await later.result
    await complete(rig, later.id, 'human-after')
    expect(listener.events[0].at(-1)).not.toHaveProperty('completion.automationOwned')
    expect(listener.phone.mock.calls.at(-1)?.[0]).toMatchObject({ worktreeId: 'workspace-1' })
    listener.stop()
  }
)

it.each([100, 1000])(
  'keeps %i same-session retained claims out of completion/token lookup work',
  async (size) => {
    const rig = await setup()
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const owner = rig.host.automationChatInterests
    const { agentJournalSubmissionKey } =
      await import('../../shared/agent-session-journal-item-key')
    const { AGENT_JOURNAL_THREAD_SCOPE } = await import('../../shared/agent-session-journal-types')
    const sink = rig.providerEvents()
    for (let index = 0; index < size; index++) {
      const message = `retained-${index}`
      rig.host.registerAutomationChatRun(`run-${index}`, SESSION, message)
      await journal.appendSubmission({
        clientMessageId: message,
        payloadFingerprint: 'a'.repeat(64),
        fence: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: message }] }
      })
      await journal.resolveDispatch({
        clientMessageId: message,
        state: 'accepted',
        providerIdentity: null,
        fence: 1
      })
      sink.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: message, ordinal: 1 },
        {
          kind: 'turn',
          turnId: message,
          userItemId: agentJournalSubmissionKey(message),
          state: 'completed',
          outcome: 'success'
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
      )
      sink.appendItem(
        { provider: 'codex', threadId: 'thread-1', turnId: message, ordinal: 2 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'historical output '.repeat(100) }]
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    expect(await sink.written?.()).toEqual({ ok: true })
    await rig.host.flushStreamedEvents(SESSION)
    rig.host.reconcileAutomationChatOwnership()
    const historical = vi.spyOn(journal, 'submissions')
    const roots = vi.spyOn(journal, 'visitItemsWithLinkage')
    const snapshots = vi.spyOn(journal, 'snapshot')
    const runs = vi.spyOn(owner['runs'], 'values')
    const messages = vi.spyOn(owner['sessions'].get(SESSION)!.messages, 'values')
    const actual = owner.observe.bind(owner)
    const work: number[][] = []
    vi.spyOn(owner, 'observe').mockImplementation((...args) => {
      const spies = [historical, roots, snapshots, runs, messages]
      const before = spies.map((spy) => spy.mock.calls.length)
      actual(...args)
      work.push(spies.map((spy, index) => spy.mock.calls.length - before[index]))
    })
    const classify = vi.spyOn(owner, 'owns')
    for (const subscribers of [1, 10]) {
      const listener = listen(rig, subscribers)
      const human = rig.send('human')
      await human.result
      await complete(rig, human.id, `human-${subscribers}`)
      const own = await ownedSend(rig, `live-${subscribers}`)
      await complete(rig, own, `own-${subscribers}`)
      for (let token = 0; token < 5; token++) {
        sink.appendItem(
          { provider: 'codex', threadId: 'thread-1', turnId: `own-${subscribers}`, ordinal: 3 },
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `token-${token}` }]
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        await sink.written?.()
        await rig.host.flushStreamedEvents(SESSION)
      }
      expect(listener.phone).toHaveBeenCalledOnce()
      listener.stop()
    }
    expect(classify).toHaveBeenCalledTimes(4)
    expect(work.length).toBeGreaterThan(10)
    expect(work.every((row) => row.every((count) => count === 0))).toBe(true)
    expect(owner['runs'].size).toBe(size + 2)
    expect(rig.host.collaboratorsForTests().sessions['observers'].size).toBe(0)
    owner.forget('run-0')
    expect(owner['runs'].size).toBe(size + 1)
    await rig.host.flushAllStreamedEvents()
    expect(owner['runs'].size).toBe(0)
    expect(owner['sessions'].size).toBe(0)
  }
)

it('retires an unaccepted reservation, retains a real refusal, and rederives roots after reset without replay', async () => {
  const rig = await setup()
  const owner = rig.host.automationChatInterests
  rig.host.registerAutomationChatRun('unaccepted', SESSION, 'never-submitted')
  rig.host.settleAutomationChatRun('unaccepted')
  expect(owner.identity('unaccepted')).toBeUndefined()
  const listener = listen(rig)
  const own = await ownedSend(rig, 'refused')
  await eventually(async () => {
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
      await rig.proveStart()
    }
    expect((await rig.submission(own))?.handedOverAt).toBeDefined()
  })
  await rig.settleRejected(own, 'provider refused the prompt')
  await rig.host.flushStreamedEvents(SESSION)
  expect(listener.events[0]).toContainEqual(
    expect.objectContaining({
      type: 'completion',
      completion: expect.objectContaining({ automationOwned: true })
    })
  )
  expect(listener.phone).not.toHaveBeenCalled()
  rig.host.settleAutomationChatRun('refused')
  expect(owner.identity('refused')).toBeDefined()
  const live = await ownedSend(rig, 'root-run')
  const key = await complete(rig, live, 'root-provider')
  const count = listener.events[0].length
  rig.host.reconcileAutomationChatOwnership()
  await rig.host.flushStreamedEvents(SESSION)
  expect(listener.events[0]).toHaveLength(count)
  expect(owner.owns(SESSION, { kind: 'turn', id: 'root-provider' })).toBe(true)
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await journal.appendTombstone(
    { provider: 'codex', threadId: THREAD, turnId: 'root-provider', ordinal: 1 },
    { fence: 1 }
  )
  expect(journal.item(key)).toBeNull()
  expect(owner.owns(SESSION, { kind: 'turn', id: 'root-provider' })).toBe(false)
  expect(owner.identity('root-run')?.turnItemId).toBeNull()
  rig.host.reconcileAutomationChatOwnership()
  expect(owner.owns(SESSION, { kind: 'turn', id: 'root-provider' })).toBe(false)
  owner.forget('root-run')
  owner.forget('refused')
  expect(owner['runs'].size).toBe(0)
  expect(owner['sessions'].size).toBe(0)
  listener.stop()
})

it('uses the canonical provider-echo alias without a separate dispatch acceptance row', async () => {
  const { agentJournalItemKey } = await import('../../shared/agent-session-journal-item-key')
  const { AGENT_JOURNAL_THREAD_SCOPE } = await import('../../shared/agent-session-journal-types')
  const { hostTestMessage } =
    await import('../native-chat/agent-session-wire/structured-agent-session-host-test-data')
  const rig = await setup()
  const listener = listen(rig)
  const id = await ownedSend(rig, 'echo-run')
  await eventually(async () => {
    if (rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
      await rig.proveStart()
    }
    expect((await rig.submission(id))?.handedOverAt).toBeDefined()
  })
  const sink = rig.providerEvents()
  const user = { provider: 'codex' as const, threadId: THREAD, turnId: 'echo-provider', ordinal: 0 }
  sink.appendItem(user, hostTestMessage('automation'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  sink.appendItem(
    { ...user, ordinal: 1 },
    {
      kind: 'turn',
      turnId: 'echo-provider',
      userItemId: agentJournalItemKey(user),
      state: 'completed',
      outcome: 'success'
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
  )
  sink.publish({ lifecycle: true })
  expect(await sink.written?.()).toEqual({ ok: true })
  await rig.host.flushStreamedEvents(SESSION)
  expect((await rig.submission(id))?.dispatchState).toBe('accepted')
  expect(listener.events[0]).toContainEqual(
    expect.objectContaining({
      type: 'completion',
      completion: expect.objectContaining({ turnId: 'echo-provider', automationOwned: true })
    })
  )
  expect(listener.phone).not.toHaveBeenCalled()
  listener.stop()
})
