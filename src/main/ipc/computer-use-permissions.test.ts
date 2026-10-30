import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

type HoistedMocks = {
  app: EventEmitter | null
  handlers: Map<string, (...args: unknown[]) => unknown>
  focusedWindow: { current: object | null }
  probe: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted((): HoistedMocks => ({
  app: null,
  handlers: new Map(),
  focusedWindow: { current: null },
  probe: vi.fn()
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  mocks.app = new Emitter()
  return {
    app: mocks.app,
    BrowserWindow: { getFocusedWindow: () => mocks.focusedWindow.current },
    ipcMain: {
      handle: (name: string, handler: (...args: unknown[]) => unknown) =>
        mocks.handlers.set(name, handler)
    }
  }
})

vi.mock('../computer/macos-computer-use-permissions', () => ({
  getComputerUsePermissionStatus: mocks.probe
}))

describe('registerComputerUsePermissionHandlers', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('re-probes passive readers only after the app itself returns', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mocks.probe.mockResolvedValue({
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      helperUnavailableReason: null,
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'granted' }
      ]
    })
    const { registerComputerUsePermissionHandlers } = await import('./computer-use-permissions')
    registerComputerUsePermissionHandlers()
    const app = mocks.app!
    const readPassively = (): unknown =>
      mocks.handlers.get('computerUsePermissions:getStatus')!({}, { background: true })

    mocks.focusedWindow.current = {}
    await readPassively()
    await readPassively()
    expect(mocks.probe).toHaveBeenCalledTimes(1)

    app.emit('did-resign-active')
    app.emit('did-become-active')
    await readPassively()
    expect(mocks.probe).toHaveBeenCalledTimes(2)
  })
})
