import { describe, expect, it } from 'vitest'
import { createCodexAgentMessageDeltaBatch } from './codex-agent-message-delta-batch'

const delta = (itemId: string, text: string) => ({
  method: 'item/agentMessage/delta',
  params: { threadId: 't', turnId: 'u', itemId, delta: text }
})

describe('createCodexAgentMessageDeltaBatch', () => {
  it('merges same-task deltas per item without reordering or losing any', async () => {
    const out: Record<string, unknown>[] = []
    const batch = createCodexAgentMessageDeltaBatch(
      (message) => out.push(message),
      (error) => {
        throw error
      }
    )
    batch.dispatch(delta('a', 'He'))
    batch.dispatch(delta('a', 'llo'))
    batch.dispatch(delta('b', ' other'))
    batch.dispatch({ method: 'item/completed', params: { itemId: 'b' } })
    batch.dispatch(delta('a', ' wor'))
    batch.dispatch({ ...delta('a', 'ld'), id: 7 })
    batch.dispatch(delta('a', '!'))
    expect(out).toHaveLength(5)
    await Promise.resolve()
    expect(out).toEqual([
      delta('a', 'Hello'),
      delta('b', ' other'),
      { method: 'item/completed', params: { itemId: 'b' } },
      delta('a', ' wor'),
      { ...delta('a', 'ld'), id: 7 },
      delta('a', '!')
    ])
  })
})
