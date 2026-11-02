import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('../ipc/ui', () => ({ sendToTrustedUIRenderer: send }))

import { isProfileStateSaveDelayed, reportProfileStateSaveDelay } from './profile-state-save-delay'

beforeEach(() => {
  reportProfileStateSaveDelay(false)
  send.mockReset()
})
afterEach(() => vi.restoreAllMocks())

it('retains current status for a reopened renderer and publishes only transitions', () => {
  expect(isProfileStateSaveDelayed()).toBe(false)
  reportProfileStateSaveDelay(true)
  reportProfileStateSaveDelay(true)
  expect(isProfileStateSaveDelayed()).toBe(true)
  expect(send).toHaveBeenCalledExactlyOnceWith('app:profileStateSaveDelayChanged', true)
  reportProfileStateSaveDelay(false)
  reportProfileStateSaveDelay(false)
  expect(isProfileStateSaveDelayed()).toBe(false)
  expect(send.mock.calls).toEqual([
    ['app:profileStateSaveDelayChanged', true],
    ['app:profileStateSaveDelayChanged', false]
  ])
})

it('preserves status when its renderer disappears during publication', () => {
  send.mockImplementationOnce(() => {
    throw new Error('destroyed renderer')
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(() => reportProfileStateSaveDelay(true)).not.toThrow()
  expect(isProfileStateSaveDelayed()).toBe(true)
  expect(warn).toHaveBeenCalledOnce()
  reportProfileStateSaveDelay(false)
  expect(isProfileStateSaveDelayed()).toBe(false)
})
