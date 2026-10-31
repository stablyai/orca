import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import * as autoSandbox from '../../codex/codex-structured-auto-sandbox'
import { expect, it, vi } from 'vitest'
import { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput
} from './structured-agent-session-handing-over'
import {
  CODEX_INPUT_FINALIZATION_ADMISSION_CASES,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'

it.each(CODEX_INPUT_FINALIZATION_ADMISSION_CASES)(
  'keeps input unwritten across %s at final admission with %i earlier cards',
  async (boundary, population) => {
    const { host, adapter, codex, config, permissionSend, stop, ...fixture } =
      codexInputFinalizationFixture()
    const { sessions, conversationDelivery, serialize } = host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const closing = boundary.includes('close') || boundary.endsWith('sleep')
    const earlier = Array.from({ length: population }, (_, index) => `perf-kept-${index}`)
    await serialize(SESSION, async () => {
      for (const messageId of earlier) {
        await journal.appendSubmission({
          clientMessageId: messageId,
          payloadFingerprint: messageId,
          body: hostTestMessage(messageId),
          source: { kind: 'user' },
          origin: 'client',
          fence: 1
        })
        await journal.resolveDispatch({
          clientMessageId: messageId,
          state: 'rejected',
          fence: 1,
          keptAsQueuedMessageId: messageId,
          ...agentSessionFailureWords(agentSessionFailureFact('chatClosed'), {
            surface: 'rejection'
          })
        })
        await journal.queuedMessages.insert({ messageId, body: hostTestMessage(messageId) })
      }
      if (population > 0) {
        await journal.markQueueReopen(1)
      }
    })
    await host.flushStreamedEvents(SESSION)
    await fixture.pick('auto')
    const measured = population > 0 ? fixture.measureInputWork('close', population) : undefined
    let later = ''
    const paused = Promise.withResolvers<unknown>()
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const deps = conversationDelivery.loop['deps']
    let signal: AbortSignal | undefined
    let frameEnded = false
    let configEntered = false
    const dispatch = adapter.dispatch.bind(adapter)
    vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
      signal = input.signal
      codex.routes['config/read'] = () => {
        configEntered = true
        return paused.promise
      }
      try {
        return await dispatch(input)
      } finally {
        frameEnded = true
      }
    })
    let id = ''
    let blocking = Promise.resolve()
    let stopping = Promise.resolve()
    try {
      id = await permissionSend('do not write after cancellation', { personality: 'friendly' })
      await vi.waitFor(() => expect(configEntered && !!signal).toBe(true))
      if (boundary === 'pending-close-cards') {
        later = await permissionSend('later queued B', { personality: 'serious' })
        await journal.queuedMessages.insert({
          messageId: 'C',
          body: hostTestMessage('waiting C'),
          options: { model: 'model-C' }
        })
      }
      const child = sessions.get(SESSION)!.child!
      const settled = host.waitForSendSettlement(SESSION, id)
      const answeredBeforeRelease = vi.fn()
      void settled.then(answeredBeforeRelease)
      let rejectedAtFence: number | undefined
      const resolve = journal.resolveDispatch.bind(journal)
      const ordered = deps.serialize
      if (boundary.startsWith('queue-')) {
        blocking = serialize(SESSION, () => {
          entered.resolve()
          return held.promise
        })
        await entered.promise
        const admission = Promise.withResolvers<void>()
        vi.spyOn(deps, 'serialize').mockImplementation((sessionId, task) => {
          admission.resolve()
          return ordered(sessionId, task)
        })
        paused.resolve(config)
        await admission.promise
      } else {
        vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (...args) => {
          if (args[0].state === 'pending') {
            entered.resolve()
            await held.promise
          }
          if (args[0].state === 'rejected') {
            rejectedAtFence = fixture.conversationFence()
          }
          return resolve(...args)
        })
        paused.resolve(config)
        await entered.promise
      }
      stopping = boundary.endsWith('exit')
        ? Promise.resolve(
            codex.connections[0]?.handlers.onExit?.(new Error('Codex exited before input'), {
              expected: false
            })
          )
        : boundary === 'pending-close-then-quit'
          ? host.close(SESSION, 'user-close')
          : boundary.endsWith('quit') || boundary === 'pending-quit-then-close'
            ? host.flushAllStreamedEvents()
            : boundary.endsWith('sleep')
              ? host.sleepWorkspace('workspace-1').then(() => {})
              : closing
                ? host.close(SESSION, 'user-close')
                : stop().then(() => {})
      if (!boundary.endsWith('exit')) {
        await vi.waitFor(() => expect(signal?.aborted && frameEnded).toBe(true))
      }
      if (boundary.includes('-then-')) {
        const second = boundary.endsWith('quit')
          ? host.flushAllStreamedEvents()
          : host.close(SESSION, 'user-close')
        stopping = Promise.all([stopping, second]).then(() => {})
      }
      expect(fixture.starts()).toHaveLength(0)
      expect(continuingStructuredAgentSessionInput(journal, id)).toBe(false)
      expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
      if (boundary.endsWith('stop')) {
        expect(fixture.submission((await settled)?.value)).toMatchObject({
          dispatchState: 'rejected',
          fence: 1,
          rejection: { kind: 'cancelled' }
        })
        expect(answeredBeforeRelease).toHaveBeenCalledOnce()
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
      } else {
        expect(answeredBeforeRelease).not.toHaveBeenCalled()
      }
      held.resolve()
      await blocking
      await stopping
      await fixture.waitForInputFinalization(journal, id)
      await conversationDelivery.loop['runs'].get(SESSION)
      await journal['queue'].drain()
      const answered = fixture.submission((await settled)?.value)
      await vi.waitFor(() => expect(journal.submission(id)?.dispatchState).toBe('rejected'))
      expect(answered).toMatchObject({
        dispatchState: 'rejected',
        fence:
          boundary === 'pending-quit-then-close'
            ? child.fence
            : closing
              ? fixture.conversationFence()
              : 1
      })
      expect(answered).toEqual(journal.submission(id))
      expect(answered?.reason).toMatch(
        /before (this message was sent|the agent started it)|provider_cancelled_before_start/
      )
      expect(answered?.rejection?.kind).toBe(
        closing
          ? 'chatClosed'
          : boundary.endsWith('quit')
            ? 'hostRestarted'
            : boundary.endsWith('exit')
              ? 'providerExited'
              : 'cancelled'
      )
      const cards = journal.queuedMessages.list()
      if (closing || boundary.endsWith('quit')) {
        expect(answered?.keptAsQueuedMessageId).toBe(id)
        expect(journal.submission(id)?.source).toEqual({ kind: 'user' })
        expect(cards.find((card) => card.messageId === id)).toMatchObject({
          body: { blocks: [{ type: 'text', text: 'do not write after cancellation' }] },
          options: { personality: 'friendly' },
          ...(later ? {} : { position: 0 })
        })
      }
      if (later) {
        expect(cards.map((card) => card.messageId)).toEqual([...earlier, later, id, 'C'])
        expect(cards[earlier.length]).toMatchObject({
          body: hostTestMessage('later queued B'),
          options: { personality: 'serious' }
        })
        expect(journal.submission(later)?.keptAsQueuedMessageId).toBe(later)
        for (const [index, messageId] of earlier.entries()) {
          expect(cards[index]).toMatchObject({ messageId, body: hostTestMessage(messageId) })
          expect(journal.submission(messageId)?.keptAsQueuedMessageId).toBe(messageId)
        }
        expect(cards[earlier.length + 2]).toMatchObject({
          body: hostTestMessage('waiting C'),
          options: { model: 'model-C' }
        })
      }
      expect(fixture.starts()).toHaveLength(0)
      await fixture.waitForInputFinalization(journal, id)
      if (boundary.includes('-then-')) {
        expect(answered?.fence).toBe(rejectedAtFence)
        expect(fixture.conversationFence()).toBe(child.fence + 1)
        expect(cards.map((card) => card.messageId)).toEqual([id])
        expect(child.close).toMatchObject({ cause: 'user-close' })
        expect(child.close).not.toHaveProperty('quit')
        expect(codex.connections[0]?.closed).toBe(true)
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)
      }
    } finally {
      paused.resolve(config)
      held.resolve()
      await blocking
      await stopping
      await fixture.waitForInputFinalization(journal, id)
      await measured?.()
    }
  }
)

it.each(['stop', 'stop-save-refusal', 'exit', 'exit-after-close-record'] as const)(
  'unwinds actual Auto preparation on %s without a late write',
  async (ending) => {
    const { host, adapter, codex, config, pick, permissionSend, stop, starts } =
      codexInputFinalizationFixture()
    const exiting = ending.startsWith('exit')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    await pick('auto')
    const paused = Promise.withResolvers<unknown>()
    let signal: AbortSignal | undefined
    const lateReads: Promise<unknown>[] = []
    const readAuto = autoSandbox.readCodexAutoSandbox
    vi.spyOn(autoSandbox, 'readCodexAutoSandbox').mockImplementation((...args) => {
      const task = readAuto(...args)
      lateReads.push(task)
      return task
    })
    let preparing = false
    let frameEnded = false
    const dispatch = adapter.dispatch.bind(adapter)
    vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
      signal = input.signal
      codex.routes['config/read'] = (params) => {
        if (!params?.cwd) {
          return config
        }
        preparing = true
        return paused.promise
      }
      try {
        return await dispatch(input)
      } finally {
        frameEnded = true
      }
    })
    const id = await permissionSend('keep exact Auto')
    const journal = host['sessions'].get(SESSION)!.journal
    try {
      await vi.waitFor(() => expect(preparing).toBe(true))
      const session = adapter['sessions'].get(SESSION)!
      const permissions = session.permissions!
      const before = { ...permissions }
      const options = [...session.options]
      const waiting = host.waitForSendSettlement(SESSION, id)
      let answeredEarly = false
      void waiting.then(() => {
        answeredEarly = true
      })
      const resolve = journal.resolveDispatch.bind(journal)
      const written = vi
        .spyOn(journal, 'resolveDispatch')
        .mockImplementation((resolution, ...rest) => {
          if (resolution.state === 'rejected') {
            expect(answeredEarly).toBe(false)
            expect(resolution).toMatchObject({
              clientMessageId: id,
              fence: 1,
              rejection: { kind: exiting ? 'providerExited' : 'cancelled' }
            })
            expect(resolution.rejection).toEqual(
              exiting ? { kind: 'providerExited', neverReachedAgent: true } : { kind: 'cancelled' }
            )
            expect(resolution.reason).toMatch(/before/)
            if (exiting) {
              expect(host['sessions'].get(SESSION)?.lastEndedChild?.failure?.detail).toEqual({
                text: 'Codex exited',
                audience: 'log'
              })
            }
          }
          return resolve(resolution, ...rest)
        })
      expect(signal?.aborted).toBe(false)
      expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
      if (ending === 'exit-after-close-record') {
        const { sessions, serialize, lifetime } = host.collaboratorsForTests()
        const child = sessions.get(SESSION)!.child!
        vi.spyOn(adapter, 'disposeSession').mockResolvedValue(false)
        await expect(
          serialize(SESSION, () => lifetime.stopAgent(SESSION, { cause: 'evict' }))
        ).rejects.toThrow()
        expect(sessions.get(SESSION)?.child).toBe(child)
        expect(child.close).toMatchObject({ cause: 'evict' })
        expect(signal?.aborted).toBe(false)
      }
      if (ending === 'stop-save-refusal') {
        const db = codexInputFinalizationFixture().database()
        const receipt = journal.receiptFor(id)
        db.exec(`CREATE TRIGGER fail_stop_receipt BEFORE INSERT ON agent_session_command_receipts
          BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
        try {
          expect(await stop()).toMatchObject({
            ok: false,
            refusal: { details: { reason: 'stopFailed', agent: 'codex' } }
          })
        } finally {
          db.exec('DROP TRIGGER fail_stop_receipt')
        }
        expect(journal.receiptFor(id)).toEqual(receipt)
        expect(journal.queuedMessages.pauses()).toEqual([])
        expect(
          journal
            .snapshot()
            .items.some(
              (item) =>
                item.body.kind === 'message' &&
                item.body.blocks.some(
                  (block) => block.type === 'text' && block.text === 'Stopped manually'
                )
            )
        ).toBe(false)
      } else if (ending === 'stop') {
        await stop()
      } else {
        codex.connections[0]?.handlers.onExit?.(
          Object.assign(new Error('Codex exited'), {
            providerDiagnostic: { text: 'Codex exited', audience: 'log' }
          }),
          { expected: false }
        )
      }
      await vi.waitFor(() => expect(signal?.aborted && frameEnded).toBe(true))
      const answered = codexInputFinalizationFixture().submission((await waiting)?.value)
      expect(answered).toMatchObject({
        dispatchState: 'rejected',
        fence: 1,
        rejection: { kind: exiting ? 'providerExited' : 'cancelled' }
      })
      expect(answered).toEqual(journal.submission(id))
      expect(starts()).toHaveLength(0)
      paused.resolve(config)
      await Promise.allSettled(lateReads)
      await codexInputFinalizationFixture().waitForInputFinalization(journal, id)
      expect(session.permissions).toBe(permissions)
      expect(permissions).toEqual(before)
      expect([...session.options]).toEqual(options)
      expect(starts()).toHaveLength(0)
      const writes = await Promise.allSettled(written.mock.results.map((result) => result.value))
      expect(writes.filter((result) => result.status === 'rejected')).toEqual([])
      if (ending === 'stop-save-refusal') {
        const next = await permissionSend('next after refused Stop')
        await vi.waitFor(() => expect(starts()).toHaveLength(1))
        expect(starts()[0]?.params).toMatchObject({
          clientUserMessageId: next,
          input: [{ type: 'text', text: 'next after refused Stop' }]
        })
        const fixture = codexInputFinalizationFixture()
        fixture.turns.start()
        fixture.turns.echo(next)
        expect(
          fixture.submission((await host.waitForSendSettlement(SESSION, next))?.value)
        ).toMatchObject({ clientMessageId: next, dispatchState: 'accepted' })
        await fixture.waitForInputFinalization(journal, next)
        expect(journal.queuedMessages.list()).toEqual([])
        expect(starts()).toHaveLength(1)
      }
    } finally {
      paused.resolve(config)
      await Promise.allSettled(lateReads)
      await codexInputFinalizationFixture().waitForInputFinalization(journal, id)
    }
  }
)

it('keeps rewind outside a committed preparation until the input settles', async () => {
  const { host, adapter, permissionSend, turns, starts, rewindTo } = codexInputFinalizationFixture()
  const { sessions, serialize, conversationDelivery } = host.collaboratorsForTests()
  const journal = sessions.get(SESSION)!.journal
  const prepared = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const dispatch = adapter.dispatch.bind(adapter)
  vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
    prepared.resolve()
    await release.promise
    return dispatch(input)
  })
  const providerRewind = vi.spyOn(adapter, 'rewind')
  let rewinding: ReturnType<typeof rewindTo> | undefined
  try {
    const id = await permissionSend('committed preparation')
    await prepared.promise
    expect(journal.submission(id)?.handedOverAt).toBeDefined()
    const epoch = journal.epoch
    const reserved = Promise.withResolvers<void>()
    const order = conversationDelivery.loop['deps'].deliveryOrder
    const reserve = order.reserve.bind(order)
    vi.spyOn(order, 'reserve').mockImplementation((sessionId) => {
      reserved.resolve()
      return reserve(sessionId)
    })
    rewinding = rewindTo(agentJournalSubmissionKey(id), epoch)
    await reserved.promise
    await serialize(SESSION, async () => {})
    expect(providerRewind).not.toHaveBeenCalled()
    expect(journal.epoch).toBe(epoch)
    expect(starts()).toHaveLength(0)
    release.resolve()
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    turns.start()
    turns.echo(id)
    await codexInputFinalizationFixture().waitForInputFinalization(journal, id)
    expect(await rewinding).toMatchObject({
      ok: false,
      refusal: { details: { rewindReason: 'busy' } }
    })
    expect(providerRewind).not.toHaveBeenCalled()
    expect(journal.epoch).toBe(epoch)
  } finally {
    release.resolve()
    await rewinding
  }
})

it('keeps earlier B before historically forced proven-unrun A through close and Resume delivery', async () => {
  const {
    host,
    adapter,
    codex,
    config,
    permissionSend,
    began,
    turns,
    starts,
    pick,
    waitForInputFinalization
  } = codexInputFinalizationFixture()
  const { sessions, serialize } = host.collaboratorsForTests()
  const journal = sessions.get(SESSION)!.journal
  const w = await permissionSend('working W')
  await began(w)
  await serialize(SESSION, () =>
    journal.queuedMessages.insert({
      messageId: 'force-C',
      body: { ...hostTestMessage('/compact'), command: { name: 'compact' } }
    })
  )
  const a = await permissionSend('forced A', { personality: 'friendly' })
  expect(journal.inputOrder.forced(a)).toBe(true)
  await serialize(SESSION, () => journal.queuedMessages.withdraw(['force-C']))
  await pick('auto')
  const preparation = Promise.withResolvers<unknown>()
  const read = vi.fn(() => preparation.promise)
  codex.routes['config/read'] = read
  try {
    turns.end('completed')
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(journal.submission(a)).toMatchObject({
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })
    const b = await permissionSend('ordinary B', { personality: 'serious' })
    expect(journal.inputOrder.forced(b)).toBe(false)
    await host.close(SESSION, 'user-close')
    await waitForInputFinalization(journal, a)
    expect(starts()).toHaveLength(1)
    const kept = journal.queuedMessages.list().filter((c) => c.state === 'waiting')
    expect.soft(kept.map((c) => c.messageId)).toEqual([b, a])
    for (const [id, personality] of [
      [a, 'friendly'],
      [b, 'serious']
    ] as const) {
      expect(kept.find((c) => c.messageId === id)?.options).toEqual(journal.submission(id)?.options)
      expect(kept.find((c) => c.messageId === id)?.options).toMatchObject({ personality })
      expect(journal.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        keptAsQueuedMessageId: id
      })
    }
    preparation.resolve(config)
    codex.routes['config/read'] = () => config
    const caller = { callerKey: 'client-1' }
    await host.revealSession(SESSION)
    const method = 'agentSession.queuedMessagesResume'
    expect(
      await host.queuedMessagesResume(caller, {
        envelope: {
          sessionId: SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method,
            sessionId: SESSION,
            fields: {}
          })
        }
      })
    ).toMatchObject({ ok: true })
    const reopened = sessions.get(SESSION)!.journal
    const delivered: string[] = []
    for (const { messageId: id } of kept) {
      await vi.waitFor(() => expect(reopened.queuedMessages.get(id)?.consumedAs).toBeTruthy())
      const h = reopened.queuedMessages.get(id)!.consumedAs!
      await began(h)
      expect(reopened.submission(h)?.dispatchState).toBe('accepted')
      delivered.push(reopened.submission(h)!.queuedMessageId!)
      turns.end('completed')
      await host.flushStreamedEvents(SESSION)
    }
    expect.soft(delivered).toEqual([b, a])
    expect(starts()).toHaveLength(3)
    expect(reopened.queuedMessages.list().filter((c) => c.state === 'waiting')).toEqual([])
    expect(reopened.queuedMessages.displayState().inputEntries.size).toBe(0)
  } finally {
    preparation.resolve(config)
    await adapter.closeAll()
  }
})
