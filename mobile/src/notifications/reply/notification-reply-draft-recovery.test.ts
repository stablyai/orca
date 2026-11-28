import { appendNotificationReplyDraftText } from './notification-reply-draft-text'
import { expect, it, vi } from 'vitest'
import { recoverNotificationReplyDrafts } from './notification-reply-draft-recovery'

it('retries transient recovery refusals while mounted, then stops on success', async () => {
  vi.useFakeTimers()
  try {
    const controller = new AbortController()
    let attempts = 0
    let restored = ''
    const recovery = recoverNotificationReplyDrafts(async () => {
      attempts += 1
      if (attempts < 3) {
        return false
      }
      restored = 'retained draft'
      return true
    }, controller.signal)
    await vi.runAllTimersAsync()
    await recovery
    expect(restored).toBe('retained draft')
    expect(attempts).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('bounds refusals and cancels pending retry work on unmount', async () => {
  vi.useFakeTimers()
  try {
    let attempts = 0
    const controller = new AbortController()
    const recovery = recoverNotificationReplyDrafts(async () => {
      attempts += 1
      return false
    }, controller.signal)
    await vi.runAllTimersAsync()
    await recovery
    expect(attempts).toBe(6)
    const canceled = new AbortController()
    const pending = recoverNotificationReplyDrafts(async () => {
      attempts += 1
      canceled.abort()
      return false
    }, canceled.signal)
    await pending
    await vi.runAllTimersAsync()
    expect(attempts).toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('does not duplicate a recovered paragraph when a save retry follows a user edit', () => {
  const initial = appendNotificationReplyDraftText('existing draft', 'returned reply')
  const edited = initial + '\n\nnewer user input'
  expect(appendNotificationReplyDraftText(edited, 'returned reply')).toBe(
    'existing draft\n\nreturned reply\n\nnewer user input'
  )
})
