import type { BrowserWindow } from 'electron'
import type * as nodeModule from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  rememberWindowMaterial,
  resolveAvailableWindowMaterial,
  setWindowMaterialSuppressed
} from './window-material-suppression'

const loadAddon = vi.hoisted(() => vi.fn())

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof nodeModule>()),
  createRequire: () => loadAddon
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/orca' }
}))

function createWindow() {
  return {
    getNativeWindowHandle: () => Buffer.alloc(8),
    isDestroyed: () => false,
    setVibrancy: vi.fn<BrowserWindow['setVibrancy']>()
  }
}

describe('native Frosted Glass fallback', () => {
  beforeEach(() => {
    loadAddon.mockReset()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => vi.restoreAllMocks())

  it('selects standard blur before the renderer starts when the addon cannot load', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadAddon.mockImplementation(() => {
      throw new Error('Addon unavailable')
    })

    expect(resolveAvailableWindowMaterial('frosted')).toBe('blur')
  })

  it('reports the native fallback if the addon refuses to attach', () => {
    loadAddon.mockReturnValue({ setBackdrop: () => false })
    const window = createWindow()

    rememberWindowMaterial(window, resolveAvailableWindowMaterial('frosted'))
    expect(window.setVibrancy).toHaveBeenLastCalledWith('under-window')
    expect(setWindowMaterialSuppressed(window, true)).toBe('blur')
  })

  it('preserves Frosted Glass when a theme image suppresses and restores it', () => {
    loadAddon.mockReturnValue({ setBackdrop: () => true })
    const window = createWindow()

    rememberWindowMaterial(window, resolveAvailableWindowMaterial('frosted'))
    expect(setWindowMaterialSuppressed(window, true)).toBe('frosted')
    expect(setWindowMaterialSuppressed(window, false)).toBe('frosted')
  })
})
