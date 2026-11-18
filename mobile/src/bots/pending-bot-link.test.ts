import { describe, expect, it } from 'vitest'
import {
  clearBotLink,
  publishBotLink,
  readPendingBotLink,
  subscribeToPendingBotLink
} from './pending-bot-link'

describe('pending bot link', () => {
  it('lets a finishing link clear only itself, never a newer one', () => {
    publishBotLink({ kind: 'bot', botId: 'atlas' })
    const first = readPendingBotLink()
    publishBotLink({ kind: 'bot', botId: 'scout' })
    const second = readPendingBotLink()

    clearBotLink(first!.id)
    expect(readPendingBotLink()).toBe(second)
    clearBotLink(second!.id)
    expect(readPendingBotLink()).toBeNull()
  })

  it('tells subscribers when the link changes', () => {
    let calls = 0
    const unsubscribe = subscribeToPendingBotLink(() => {
      calls += 1
    })
    publishBotLink({ kind: 'access-request', token: 't' })
    clearBotLink(readPendingBotLink()!.id)
    unsubscribe()
    publishBotLink({ kind: 'bot', botId: 'atlas' })
    expect(calls).toBe(2)
  })
})
