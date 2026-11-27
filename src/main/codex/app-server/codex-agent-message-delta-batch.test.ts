import { describe, expect, it } from 'vitest'
import { createCodexAgentMessageDeltaBatch } from './codex-agent-message-delta-batch'

const delta = (itemId: string, text: string) => ({
  method: 'item/agentMessage/delta',
  params: { threadId: 't', turnId: 'u', itemId, delta: text }
})

describe('createCodexAgentMessageDeltaBatch', () => {
  it('merges same-task deltas per item without reordering, losing any, or passing a pause', async () => {
    const out: unknown[] = []
    let paused = false
    const batch = createCodexAgentMessageDeltaBatch({
      dispatch: (message) => {
        out.push(message)
        // The handler for item b's delta applies backpressure.
        paused ||= JSON.stringify(message).includes(' other')
      },
      onError: (error) => {
        throw error
      },
      isPaused: () => paused
    })
    batch.dispatch(delta('a', 'He'))
    batch.dispatch(delta('a', 'llo'))
    batch.dispatch(delta('b', ' other'))
    batch.dispatch({ id: 9, method: 'item/commandExecution/requestApproval', params: {} })
    batch.handOn(() => out.push('rejected line'))
    batch.dispatch(delta('a', ' wor'))
    await Promise.resolve()
    expect(out).toEqual([delta('a', 'Hello'), delta('b', ' other')])

    paused = false
    batch.resume()
    batch.dispatch(delta('a', 'ld'))
    batch.dispatch({ ...delta('a', '!'), id: 7 })
    await Promise.resolve()
    expect(out).toEqual([
      delta('a', 'Hello'),
      delta('b', ' other'),
      { id: 9, method: 'item/commandExecution/requestApproval', params: {} },
      'rejected line',
      delta('a', ' wor'),
      delta('a', 'ld'),
      { ...delta('a', '!'), id: 7 }
    ])
  })
})
