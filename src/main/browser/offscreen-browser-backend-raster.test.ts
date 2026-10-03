import { EventEmitter } from 'node:events'
import type { BrowserWindowConstructorOptions } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted((): { options: BrowserWindowConstructorOptions[] } => ({ options: [] }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = Object.assign(new EventEmitter(), {
      id: 1,
      loadURL: async () => {
        queueMicrotask(() => this.webContents.emit('did-finish-load'))
      }
    })
    constructor(options: BrowserWindowConstructorOptions) {
      state.options.push(options)
    }
    isDestroyed() {
      return false
    }
    destroy() {
      this.webContents.emit('destroyed')
    }
  }
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:orca-browser' })
  }
}))

import { OffscreenBrowserBackend } from './offscreen-browser-backend'

async function windowOptions(value: string | undefined) {
  vi.stubEnv('ORCA_EXPERIMENTAL_BROWSER_RASTER_SCALE', value)
  const manager = { registerOffscreenGuest: () => true, unregisterGuest: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fake implements the manager methods exercised by creating and closing a tab.
  const backend = new OffscreenBrowserBackend(manager as never)
  await backend.createTab({ browserPageId: 'page', worktreeId: 'workspace', url: 'about:blank' })
  await backend.destroyAll()
  return state.options.at(-1)!
}

afterEach(() => {
  state.options.length = 0
  vi.unstubAllEnvs()
})

describe('headless raster opt-in', () => {
  it.each([undefined, '', 'invalid', '0', '-1', '3.1', 'Infinity'])(
    'preserves the hidden-window default for %s',
    async (value) => {
      const options = await windowOptions(value)
      expect(options.show).toBe(false)
      expect(options.webPreferences?.offscreen).toBeUndefined()
      expect(options.webPreferences?.sandbox).toBe(true)
      expect(options.webPreferences?.contextIsolation).toBe(true)
    }
  )
  it.each(['1', '1.5', '2', '3'])('selects actual offscreen output scale %s', async (value) => {
    const options = await windowOptions(value)
    expect(options.show).toBe(false)
    expect(options.frame).toBe(false)
    expect(options.webPreferences?.offscreen).toEqual({
      useSharedTexture: false,
      deviceScaleFactor: Number(value)
    })
    expect(options.webPreferences?.partition).toBe('persist:orca-browser')
  })
})
