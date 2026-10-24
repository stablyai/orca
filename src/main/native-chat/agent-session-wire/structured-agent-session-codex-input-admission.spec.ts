import { expect, it, vi } from 'vitest'
import { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput
} from './structured-agent-session-handing-over'
import {
  CODEX_INPUT_FINALIZATION_ADMISSION_CASES,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
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
