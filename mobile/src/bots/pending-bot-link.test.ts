import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  clearBotLink,
  publishBotLink,
  readPendingBotLink,
  subscribeToPendingBotLink
} from './pending-bot-link'

describe('pending bot link', () => {
  it('notifies subscribers only when the pending link changes', () => {
    const notify = vi.fn()
    const unsubscribe = subscribeToPendingBotLink(notify)
    onTestFinished(() => {
      unsubscribe()
      const pending = readPendingBotLink()
      if (pending) {
        clearBotLink(pending.id)
      }
    })

    publishBotLink({ kind: 'bot', botId: 'atlas' })
    const first = readPendingBotLink()
    publishBotLink({ kind: 'bot', botId: 'scout' })
    const second = readPendingBotLink()
    expect(notify).toHaveBeenCalledTimes(2)

    clearBotLink(first!.id)
    expect(readPendingBotLink()).toBe(second)
    expect(notify).toHaveBeenCalledTimes(2)

    clearBotLink(second!.id)
    expect(readPendingBotLink()).toBeNull()
    expect(notify).toHaveBeenCalledTimes(3)

    unsubscribe()
    publishBotLink({ kind: 'bot', botId: 'atlas' })
    expect(notify).toHaveBeenCalledTimes(3)
  })
})
