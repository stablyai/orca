import { describe, expect, it } from 'vitest'
import { NOT_IN_A_THREAD, notInAThread, type RunReplySources } from './bot-run-reply-place'

const sources: RunReplySources = {
  listAutomationRuns: () => [
    { automationId: 'old', chatSessionId: 'run-chat', status: 'completed' },
    { automationId: 'a1', chatSessionId: 'run-chat', status: 'dispatched' }
  ],
  showAutomation: (id) => {
    if (id !== 'a1') {
      throw new Error('gone')
    }
    return { bot: { botId: 'b1', runsIn: 'new', resultsTo: { channel: 'C9', label: '#news' } } }
  }
}

describe('a reply refused in a run that is in no thread', () => {
  it('names where the run posts its final message', () => {
    const error = notInAThread(sources, 'run-chat')
    expect(error).toMatchObject({ code: NOT_IN_A_THREAD })
    expect(error.message).toBe(
      "Nothing was posted: this run's conversation isn't in a thread. Your final message posts as a new top-level post in #news. Put your answer there."
    )
  })

  it('stays the bare code for any other chat', () => {
    expect(notInAThread(sources, 'home').message).toBe(NOT_IN_A_THREAD)
    expect(notInAThread(sources, undefined).message).toBe(NOT_IN_A_THREAD)
  })
})
