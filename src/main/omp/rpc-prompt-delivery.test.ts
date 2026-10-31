import { afterEach, expect, it, vi } from 'vitest'
import { PiRpcPromptDelivery } from '../pi/rpc-prompt-delivery'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

afterEach(() => vi.useRealTimers())

it('matches OMP admissions by identity and never resends an authentication refusal', async () => {
  vi.useFakeTimers()
  const sent: JsonlRpcRecord[] = []
  const settled = vi.fn()
  const delivery = new PiRpcPromptDelivery({
    correlated: true,
    send: async (frame) => {
      sent.push(frame)
    },
    settled,
    accepted: vi.fn(),
    commandOnly: vi.fn(),
    rejectedAfterAcceptance: vi.fn(),
    failed: vi.fn()
  })
  try {
    await delivery.submit('first', 1, { type: 'prompt', message: 'first' })
    await delivery.submit('second', 2, { type: 'prompt', message: 'second' })
    delivery.reply({
      type: 'response',
      command: 'prompt',
      promptId: sent[1]?.id,
      success: false,
      error: 'No API key found for provider'
    })
    expect(settled).toHaveBeenCalledWith('second', expect.objectContaining({ state: 'rejected' }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(2)
    delivery.reply({
      type: 'response',
      command: 'prompt',
      promptId: sent[0]?.id,
      success: false,
      error: 'unavailable'
    })
    expect(settled).toHaveBeenLastCalledWith(
      'first',
      expect.objectContaining({ state: 'rejected' })
    )
  } finally {
    delivery.end()
  }
})
