import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_AUTOMATION_ACTIVITY_CHANNEL,
  BROWSER_AUTOMATION_ACTIVITY_LEASE_MS,
  BROWSER_AUTOMATION_ACTIVITY_RENEW_MS
} from '../../shared/browser-automation-activity'
import { holdBrowserAutomationActivity } from './browser-automation-activity-lease'

class ActivityContents extends EventEmitter {
  destroyed = false
  send = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

describe('browser automation activity leases', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renews one exact page until its idempotent release and removes its listeners', () => {
    const guest = new ActivityContents()
    const renderer = new ActivityContents()
    const release = holdBrowserAutomationActivity('page-b', guest, renderer, () => true)

    expect(renderer.send).toHaveBeenLastCalledWith(BROWSER_AUTOMATION_ACTIVITY_CHANNEL, {
      browserPageId: 'page-b',
      token: expect.any(String),
      active: true,
      expiresAt: 1_000 + BROWSER_AUTOMATION_ACTIVITY_LEASE_MS
    })
    const initial = renderer.send.mock.calls[0][1]
    vi.advanceTimersByTime(BROWSER_AUTOMATION_ACTIVITY_RENEW_MS * 5)
    expect(renderer.send).toHaveBeenCalledTimes(6)
    expect(renderer.send.mock.calls.at(-1)?.[1]).toEqual({
      ...initial,
      expiresAt: Date.now() + BROWSER_AUTOMATION_ACTIVITY_LEASE_MS
    })

    release()
    release()
    expect(renderer.send).toHaveBeenCalledTimes(7)
    expect(renderer.send).toHaveBeenLastCalledWith(BROWSER_AUTOMATION_ACTIVITY_CHANNEL, {
      ...initial,
      active: false,
      expiresAt: Date.now()
    })
    expect(guest.listenerCount('destroyed')).toBe(0)
    expect(renderer.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses separate tokens for overlapping commands and releases each independently', () => {
    const guest = new ActivityContents()
    const renderer = new ActivityContents()
    const releaseFirst = holdBrowserAutomationActivity('page-a', guest, renderer, () => true)
    const releaseSecond = holdBrowserAutomationActivity('page-a', guest, renderer, () => true)
    const first = renderer.send.mock.calls[0][1]
    const second = renderer.send.mock.calls[1][1]
    expect(first.token).not.toBe(second.token)

    releaseFirst()
    vi.advanceTimersByTime(BROWSER_AUTOMATION_ACTIVITY_RENEW_MS)
    expect(renderer.send.mock.calls.at(-1)?.[1]).toMatchObject({
      token: second.token,
      active: true
    })
    releaseSecond()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['guest', 'renderer', 'owner'])(
    'stops publishing after its %s is gone',
    (unavailable) => {
      const guest = new ActivityContents()
      const renderer = new ActivityContents()
      let currentOwner = true
      const release = holdBrowserAutomationActivity('page-a', guest, renderer, () => currentOwner)
      if (unavailable === 'guest') {
        guest.destroy()
      } else if (unavailable === 'renderer') {
        renderer.destroy()
      } else {
        currentOwner = false
      }
      vi.advanceTimersByTime(BROWSER_AUTOMATION_ACTIVITY_RENEW_MS)
      const callCount = renderer.send.mock.calls.length
      vi.advanceTimersByTime(BROWSER_AUTOMATION_ACTIVITY_LEASE_MS)
      expect(renderer.send).toHaveBeenCalledTimes(callCount)
      expect(vi.getTimerCount()).toBe(0)
      expect(() => release()).not.toThrow()
    }
  )

  it('keeps a failing status transport out of command execution', () => {
    const guest = new ActivityContents()
    const renderer = new ActivityContents()
    renderer.send.mockImplementation(() => {
      throw new Error('renderer unavailable')
    })
    const release = holdBrowserAutomationActivity('page-a', guest, renderer, () => true)
    expect(() => release()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
    expect(guest.listenerCount('destroyed')).toBe(0)
  })

  it('cleans up a partially registered lease if renderer teardown races its creation', () => {
    const guest = new ActivityContents()
    const renderer = new ActivityContents()
    vi.spyOn(renderer, 'once').mockImplementation(() => {
      throw new Error('renderer wrapper unavailable')
    })
    const release = holdBrowserAutomationActivity('page-a', guest, renderer, () => true)
    expect(() => release()).not.toThrow()
    expect(guest.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
