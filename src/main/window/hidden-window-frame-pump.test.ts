import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL } from '../../shared/hidden-window-frame-pump'
import { stopHiddenWindowFramePumpOnShow } from './hidden-window-frame-pump'

function fakeWindow(destroyed = false) {
  const windowEvents = new EventEmitter()
  const contentsEvents = new EventEmitter()
  const send = vi.fn()
  const window = {
    on: (event: 'show', listener: () => void) => windowEvents.on(event, listener),
    webContents: {
      isDestroyed: () => destroyed,
      on: (event: 'did-finish-load', listener: () => void) => contentsEvents.on(event, listener),
      send
    }
  }
  return { window, windowEvents, contentsEvents, send }
}

describe('stopHiddenWindowFramePumpOnShow', () => {
  it('keeps pumping across reloads while the window has never been shown', () => {
    const { window, contentsEvents, send } = fakeWindow()
    stopHiddenWindowFramePumpOnShow(window)

    contentsEvents.emit('did-finish-load')

    expect(send).not.toHaveBeenCalled()
  })

  it('stops on the first show and again after a later reload restarts the pump', () => {
    const { window, windowEvents, contentsEvents, send } = fakeWindow()
    stopHiddenWindowFramePumpOnShow(window)

    windowEvents.emit('show')
    windowEvents.emit('show')
    contentsEvents.emit('did-finish-load')

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL)
  })

  it('sends nothing to destroyed contents', () => {
    const { window, windowEvents, send } = fakeWindow(true)
    stopHiddenWindowFramePumpOnShow(window)

    windowEvents.emit('show')

    expect(send).not.toHaveBeenCalled()
  })
})
