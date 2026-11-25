import { expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestSendParams
} from './structured-agent-session-host-test-data.test-fixture'
import {
  accept,
  CALLER,
  dispatch,
  eventually,
  host,
  proveOpen,
  publishFirst,
  registerStartupAttemptHostTests,
  restartWith,
  store,
  submission,
  turnPlan
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

it.each(['metadata', 'note'] as const)(
  'keeps the repaired task accepted after later %s persistence fails',
  async (failure) => {
    const seed = await accept('seed provider history')
    await proveOpen()
    await eventually(async () => expect((await submission(seed))?.dispatchState).toBe('accepted'))
    await restartWith(publishFirst, { botHome: true, supportsGoals: true })
    const failed = Promise.withResolvers<void>()
    if (failure === 'note') {
      turnPlan.mockResolvedValueOnce({
        text: 'A genuinely newer SOUL update.',
        given: () => {},
        note: { kind: 'status', presentation: 'bot-context', text: 'Updated soul applied' }
      })
    }
    dispatch.mockImplementationOnce(async () => {
      if (failure === 'metadata') {
        vi.spyOn(store, 'updateRecord').mockImplementationOnce(async () => {
          failed.resolve()
          throw new Error('metadata storage unavailable')
        })
      } else {
        const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
        const append = journal.appendItem.bind(journal)
        vi.spyOn(journal, 'appendItem').mockImplementation(async (...args) => {
          if (args[1].kind === 'status' && args[1].presentation === 'bot-context') {
            failed.resolve()
            throw new Error('note storage unavailable')
          }
          return append(...args)
        })
      }
      return {
        state: 'accepted',
        providerIdentity: {
          provider: 'codex',
          threadId: 'thread-alpha',
          turnId: 'task',
          ordinal: 1
        },
        ranOptions: { model: 'gpt-6.1-sol', effort: 'xhigh' }
      }
    })
    const params = hostTestSendParams('one owner task')
    expect(await host.send(CALLER, { ...params, userSend: true })).toMatchObject({ ok: true })
    await proveOpen()
    await failed.promise
    await host.flushStreamedEvents(SESSION)
    expect(await submission(params.envelope.clientOperationId)).toMatchObject({
      dispatchState: 'accepted',
      providerItemId: 'codex:thread-alpha:task:1'
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const final = await submission(params.envelope.clientOperationId)
    expect(final?.dispatchState).toBe('accepted')
    expect(final?.rejection).toBeUndefined()
  }
)
