import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installWindowGlassLifecycle } from './window-glass-lifecycle'
import type { WindowGlassEnvironment } from './window-glass-policy'

function fixture(overrides: Partial<WindowGlassEnvironment> = {}) {
  const environment: WindowGlassEnvironment = {
    platform: 'darwin',
    release: '25.0.0',
    requested: true,
    dark: true,
    reducedTransparency: false,
    highContrast: false,
    softwareRendering: false,
    ...overrides
  }
  const theme = new EventEmitter()
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
    isDestroyed: vi.fn(() => false),
    setBackgroundColor: vi.fn(),
    setVibrancy: vi.fn(),
    setBackgroundMaterial: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements exactly the BrowserWindow surface used by the lifecycle.
  installWindowGlassLifecycle(window as unknown as BrowserWindow, theme, () => environment)
  return { theme, window, environment }
}

describe('window glass lifecycle', () => {
  it('publishes the native initial state after each renderer load', () => {
    const { window } = fixture()
    window.webContents.emit('did-finish-load')
    expect(window.webContents.send).toHaveBeenCalledWith('window-glass:changed', true)
  })
  it('removes native vibrancy immediately when accessibility changes and restores it', () => {
    const { window, theme, environment } = fixture()
    environment.reducedTransparency = true
    theme.emit('updated')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#0a0a0a')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.webContents.send).toHaveBeenLastCalledWith('window-glass:changed', false)
    environment.reducedTransparency = false
    theme.emit('updated')
    expect(window.setVibrancy).toHaveBeenLastCalledWith('under-window')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    expect(window.webContents.send).toHaveBeenLastCalledWith('window-glass:changed', true)
  })
  it('updates the solid backing for theme changes and high contrast', () => {
    const { window, theme, environment } = fixture()
    environment.highContrast = true
    environment.dark = false
    theme.emit('updated')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff')
    expect(window.webContents.send).toHaveBeenLastCalledWith('window-glass:changed', false)
  })
  it('disables supported Windows acrylic in safe graphics mode', () => {
    const { window, theme, environment } = fixture({ platform: 'win32', release: '10.0.22621' })
    environment.softwareRendering = true
    theme.emit('updated')
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith('none')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#0a0a0a')
    expect(window.setVibrancy).not.toHaveBeenCalled()
  })
  it('cleans listeners on close and leaves destroyed windows alone', () => {
    const { window, theme } = fixture()
    window.isDestroyed.mockReturnValue(true)
    theme.emit('updated')
    expect(window.setBackgroundColor).not.toHaveBeenCalled()
    window.emit('closed')
    expect(theme.listenerCount('updated')).toBe(0)
    expect(window.webContents.listenerCount('did-finish-load')).toBe(0)
  })
})
