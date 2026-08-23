import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { loadRendererWithPtyRecovery, reloadPromotedControl } from './promoted-control-reload'
import { createWebContentsTimedFlag } from './web-contents-timed-flag'

function createWebContents(
  reload: () => void,
  id = 17
): EventEmitter & { id: number; reload: () => void } {
  return Object.assign(new EventEmitter(), { id, reload: vi.fn(reload) })
}

describe('promoted control reload', () => {
  it('lets the PTY load listener consume a successful reload exactly once', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => webContents.emit('did-finish-load'))
    const consumed: boolean[] = []
    webContents.on('did-finish-load', () => {
      consumed.push(flag.matches(webContents.id, { consume: true }))
    })

    loadRendererWithPtyRecovery(webContents as unknown as WebContents, flag, () =>
      webContents.reload()
    )

    expect(consumed).toEqual([true])
    expect(flag.matches(webContents.id, { consume: true })).toBe(false)
    expect(webContents.listenerCount('did-finish-load')).toBe(1)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('clears a failed main-frame reload before the next load', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => undefined)

    loadRendererWithPtyRecovery(webContents as unknown as WebContents, flag, () =>
      webContents.reload()
    )
    webContents.emit('did-fail-load', {}, -2, 'failed', 'orca://renderer', true, 1, 2)

    expect(flag.matches(webContents.id, { consume: true })).toBe(false)
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('clears a destroyed web contents reload', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => undefined)

    loadRendererWithPtyRecovery(webContents as unknown as WebContents, flag, () =>
      webContents.reload()
    )
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

    expect(() =>
      loadRendererWithPtyRecovery(webContents as unknown as WebContents, flag, () =>
        webContents.reload()
      )
    ).toThrow(failure)
    expect(flag.matches(webContents.id, { consume: true })).toBe(false)
    expect(webContents.listenerCount('did-finish-load')).toBe(0)
    expect(webContents.listenerCount('did-fail-load')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it('re-marks a new automatic attempt after a failed attempt clears', () => {
    const flag = createWebContentsTimedFlag()
    const webContents = createWebContents(() => undefined)

    loadRendererWithPtyRecovery(webContents as unknown as WebContents, flag, () =>
      webContents.reload()
    )
    webContents.emit('did-fail-load', {}, -2, 'failed', 'orca://renderer', true, 1, 2)
    loadRendererWithPtyRecovery(webContents as unknown as WebContents, flag, () =>
      webContents.reload()
    )

    expect(flag.matches(webContents.id, { consume: true })).toBe(true)
  })

  it('clears a failed attempt without touching another web contents attempt', () => {
    const flag = createWebContentsTimedFlag()
    const first = createWebContents(() => undefined, 17)
    const second = createWebContents(() => undefined, 18)

    loadRendererWithPtyRecovery(first as unknown as WebContents, flag, () => first.reload())
    loadRendererWithPtyRecovery(second as unknown as WebContents, flag, () => second.reload())
    first.emit('destroyed')

    expect(flag.matches(first.id, { consume: true })).toBe(false)
    expect(flag.matches(second.id, { consume: true })).toBe(true)
  })
})
