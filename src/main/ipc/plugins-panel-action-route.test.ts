import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import type { PluginService } from '../plugins/plugin-service'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  forward: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('../plugins/panels/guest-isolation/plugin-frame-guest-sessions', () => ({
  bindPluginFrameGuests: () => {},
  clearPluginFrameStorage: async () => {},
  preparePluginFrameGuest: async () => null
}))
vi.mock('./plugin-remote-panel-ipc', () => ({
  registerPluginRemotePanelHandlers: () => ({
    openPush: () => false,
    closePush: () => {},
    forward: mocks.forward
  })
}))

const { registerPluginHandlers } = await import('./plugins')

afterEach(() => {
  mocks.handlers.clear()
  mocks.forward.mockReset()
})

describe('plugins:panelAction', () => {
  it('keeps a call on its host when the panel leaves the host while plugins refresh', async () => {
    let finishRefresh: () => void = () => undefined
    const execute = vi.fn().mockResolvedValue({ ok: true, value: 'this computer' })
    const service = {
      panels: { execute },
      whenReady: () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve
        }),
      findApprovedPlugin: () => null,
      getDiscovered: () => [],
      options: {}
    }
    registerPluginHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only getSettings from the store.
      { getSettings: () => ({}) } as unknown as Store,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action handler reads only panels.execute and whenReady.
      service as unknown as PluginService
    )
    let bound = true
    mocks.forward.mockImplementation(() =>
      bound ? Promise.resolve({ ok: true, value: 'the host' }) : null
    )
    const handler = mocks.handlers.get('plugins:panelAction')
    const answer = handler?.({ sender: Object.assign(new EventEmitter(), { id: 1 }) }, {})

    bound = false
    finishRefresh()

    await expect(answer).resolves.toEqual({ ok: true, value: 'the host' })
    expect(execute).not.toHaveBeenCalled()
  })
})
