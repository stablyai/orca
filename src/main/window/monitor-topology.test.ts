import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installMonitorTopologyRecovery } from './monitor-topology'

function createWindow(bounds: Electron.Rectangle, maximized = false) {
  const events = new EventEmitter()
  let currentBounds = bounds
  let currentMaximized = maximized
  return {
    events,
    window: {
      getBounds: vi.fn(() => currentBounds),
      getNormalBounds: vi.fn(() => currentBounds),
      isDestroyed: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      removeListener: events.removeListener.bind(events),
      isMaximized: vi.fn(() => currentMaximized),
      maximize: vi.fn(() => {
        currentMaximized = true
      }),
      on: events.on.bind(events),
      setBounds: vi.fn((next: Electron.Rectangle) => {
        currentBounds = next
      }),
      unmaximize: vi.fn(() => {
        currentMaximized = false
      })
    }
  }
}

describe('installMonitorTopologyRecovery', () => {
  it.each(['display-removed', 'display-metrics-changed'] as const)(
    'recovers affected windows on %s without revealing or focusing them',
    (event) => {
      const screen = new EventEmitter()
      const { window } = createWindow({ x: 2000, y: 100, width: 900, height: 700 })
      installMonitorTopologyRecovery({
        displays: () => [
          { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }
        ],
        screen,
        window: window as never
      })

      screen.emit(event)

      expect(window.setBounds).toHaveBeenCalledWith({ x: 380, y: 100, width: 900, height: 700 })
      expect(window).not.toHaveProperty('show')
      expect(window).not.toHaveProperty('focus')
    }
  )

  it('preserves reachable normal geometry', () => {
    const screen = new EventEmitter()
    const { window } = createWindow({ x: 80, y: 40, width: 900, height: 700 })
    installMonitorTopologyRecovery({
      displays: () => [
        { id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }
      ],
      screen,
      window: window as never
    })

    screen.emit('display-metrics-changed')

    expect(window.setBounds).not.toHaveBeenCalled()
  })

  it('recovers normal bounds and restores maximized state', () => {
    const screen = new EventEmitter()
    const { window } = createWindow({ x: -1900, y: 50, width: 1000, height: 700 }, true)
    const onRecovered = vi.fn()
    installMonitorTopologyRecovery({
      displays: () => [
        { id: 1, scaleFactor: 2, workArea: { x: 0, y: 0, width: 1440, height: 900 } }
      ],
      screen,
      onRecovered,
      window: window as never
    })

    screen.emit('display-removed')

    expect(window.unmaximize).toHaveBeenCalledOnce()
    expect(window.setBounds).toHaveBeenCalledWith({ x: 0, y: 50, width: 1000, height: 700 })
    expect(window.maximize).toHaveBeenCalledOnce()
    expect(onRecovered).toHaveBeenCalledWith({ x: 0, y: 50, width: 1000, height: 700 }, true)
    expect(onRecovered.mock.invocationCallOrder[0]).toBeGreaterThan(
      window.maximize.mock.invocationCallOrder[0]
    )
  })

  it('disposes screen listeners when the window closes', () => {
    const screen = new EventEmitter()
    const { events, window } = createWindow({ x: 80, y: 40, width: 900, height: 700 })
    installMonitorTopologyRecovery({
      displays: () => [],
      screen,
      window: window as never
    })

    expect(screen.listenerCount('display-removed')).toBe(1)
    expect(screen.listenerCount('display-metrics-changed')).toBe(1)
    events.emit('closed')
    expect(screen.listenerCount('display-removed')).toBe(0)
    expect(screen.listenerCount('display-metrics-changed')).toBe(0)
  })
})

it.each(['isMinimized', 'isFullScreen'] as const)('defers recovery while %s', (method) => {
  const screen = new EventEmitter()
  const { window, events } = createWindow({ x: 2000, y: 100, width: 900, height: 700 })
  window[method].mockReturnValue(true)
  installMonitorTopologyRecovery({
    displays: () => [{ id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }],
    screen,
    window: window as never
  })
  screen.emit('display-removed')
  expect(window.setBounds).not.toHaveBeenCalled()
  window[method].mockReturnValue(false)
  events.emit(method === 'isMinimized' ? 'restore' : 'leave-full-screen')
  expect(window.setBounds).toHaveBeenCalledOnce()
})
it('does not maximize a hidden window during recovery', () => {
  const screen = new EventEmitter()
  const { window } = createWindow({ x: 2000, y: 100, width: 900, height: 700 }, true)
  window.isVisible.mockReturnValue(false)
  installMonitorTopologyRecovery({
    displays: () => [{ id: 1, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1280, height: 800 } }],
    screen,
    window: window as never
  })
  screen.emit('display-removed')
  expect(window.maximize).not.toHaveBeenCalled()
  expect(window.unmaximize).not.toHaveBeenCalled()
})
