import { expect, it } from 'vitest'
import { limitedLookContinuesInItsChat } from './bot-look-around-failures'

const idle = { running: false, stillLimited: true, continueScheduled: false }

it('a usage-limited look keeps its slot while its chat continues, and after the continue finished', () => {
  expect(limitedLookContinuesInItsChat({ ...idle, continueScheduled: true })).toBe(true)
  expect(limitedLookContinuesInItsChat({ ...idle, running: true })).toBe(true)
  // The continued turn succeeded: the chat no longer ends at the limit.
  expect(limitedLookContinuesInItsChat({ ...idle, stillLimited: false })).toBe(true)
})

it('leaves the slot owed when nothing will continue the limited chat', () => {
  expect(limitedLookContinuesInItsChat(idle)).toBe(false)
})
