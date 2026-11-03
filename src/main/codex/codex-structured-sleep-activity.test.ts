import { expect, it, vi } from 'vitest'
import sleepFrames from './__fixtures__/codex-app-server-sleep.json'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

// Recorded from Codex 0.162.1 app-server calling clock.sleep on 2026-11-03.
it('publishes the requested sleep duration and clears it before the next activity', () => {
  const setActivity = vi.fn()
  const threadId = sleepFrames[0]!.params.threadId
  const turnId = sleepFrames[0]!.params.turnId
  const translator = createCodexJournalTranslator({
    sink: { appendItem: () => {}, publish: () => {}, setActivity },
    primaryThreadId: () => threadId
  })
  const notify = (method: string, params: unknown) =>
    translator.handle({
      type: 'notification',
      sessionId: 'sleep-session',
      threadId,
      method,
      params
    })
  notify('turn/started', { turn: { id: turnId } })
  for (const frame of sleepFrames) {
    notify(frame.method, frame.params)
  }
  expect(setActivity.mock.calls.slice(-2)).toEqual([[{ turnId, text: 'Waiting for 1s' }], [null]])
  notify('item/started', { turnId, item: { id: 'response', type: 'agentMessage', text: '' } })
  expect(setActivity).toHaveBeenLastCalledWith({ turnId, text: 'Drafting a response' })
})
