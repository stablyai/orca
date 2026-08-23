import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { reloadPromotedControl } from './promoted-control-reload'
import { createWebContentsTimedFlag } from './web-contents-timed-flag'

function createWebContents(reload: () => void): EventEmitter & { id: number; reload: () => void } {
  return Object.assign(new EventEmitter(), { id: 17, reload: vi.fn(reload) })
}

describe('promoted control reload', () => {
  it('lets the PTY load listener consume a successful reload exactly once', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => webContents.emit('did-finish-load'))
    const consumed: boolean[] = []
    webContents.on('did-finish-load', () => {
      consumed.push(flag.matches(webContents.id, { consume: true }))
    })

    reloadPromotedControl(webContents as unknown as WebContents, flag)

    expect(consumed).toEqual([true])
    expect(flag.matches(webContents.id, { consume: true })).toBe(false)
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('clears a failed main-frame reload before the next load', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => undefined)

    reloadPromotedControl(webContents as unknown as WebContents, flag)
    webContents.emit('did-fail-load', {}, -2, 'failed', 'orca://renderer', true, 1, 2)

    expect(flag.matches(webContents.id, { consume: true })).toBe(false)
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('clears a destroyed web contents reload', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => undefined)

    reloadPromotedControl(webContents as unknown as WebContents, flag)
    webContents.emit('destroyed')

    expect(flag.matches(webContents.id, { consume: true })).toBe(false)
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('keeps suppression after a subframe failure until the main frame finishes', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => undefined)
    const consumed: boolean[] = []
    webContents.on('did-finish-load', () => {
      consumed.push(flag.matches(webContents.id, { consume: true }))
    })

    reloadPromotedControl(webContents as unknown as WebContents, flag)
    webContents.emit('did-fail-load', {}, -2, 'failed', 'orca://subframe', false, 1, 2)
    webContents.emit('did-finish-load')

    expect(consumed).toEqual([true])
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('clears suppression and listeners when reload throws synchronously', () => {
    const failure = new Error('reload failed')
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => {
      throw failure
    })

    expect(() => reloadPromotedControl(webContents as unknown as WebContents, flag)).toThrow(failure)
    expect(flag.matches(webContents.id, { consume: true })).toBe(false)
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })
})
