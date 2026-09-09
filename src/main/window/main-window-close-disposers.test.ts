import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  getMainWindowNativeCloseListenerBudget,
  registerMainWindowCloseDisposer
} from './main-window-close-disposers'

describe('main-window close disposers', () => {
  it('composes subsystem cleanup behind one native closed listener', () => {
    const window = new EventEmitter() as BrowserWindow
    const first = vi.fn()
    const second = vi.fn()

    registerMainWindowCloseDisposer(window, first)
    registerMainWindowCloseDisposer(window, second)

    expect(getMainWindowNativeCloseListenerBudget(window)).toBe(1)
    window.emit('closed')
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('allows a subsystem to unregister before close', () => {
    const window = new EventEmitter() as BrowserWindow
    const dispose = vi.fn()
    const unregister = registerMainWindowCloseDisposer(window, dispose)

    unregister()
    window.emit('closed')

    expect(dispose).not.toHaveBeenCalled()
  })
})
