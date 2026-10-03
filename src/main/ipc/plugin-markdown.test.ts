import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginService } from '../plugins/plugin-service'
import type { Store } from '../persistence'

const mocks = vi.hoisted(() => ({
  handle:
    vi.fn<
      (
        channel: string,
        handler: (event: { sender: EventEmitter & { id: number } }, args?: unknown) => unknown
      ) => void
    >()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
import { registerPluginHandlers } from './plugins'

beforeEach(() => mocks.handle.mockClear())

function setup() {
  const service = new PluginService({
    userDataPath: '/fixture',
    hostVersion: '1.0.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({}),
    getDevPluginPaths: () => []
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Registration only subscribes to settings changes; this fixture exercises no persistence writes.
  const store = { onSettingsChanged: vi.fn() } as unknown as Store
  registerPluginHandlers(store, service, null)
  const handler = (channel: string) => {
    const entry = mocks.handle.mock.calls.find(([name]) => name === channel)
    if (!entry) {
      throw new Error(`missing ${channel}`)
    }
    return entry[1]
  }
  return { service, handler }
}

describe('Markdown IPC owner boundary', () => {
  it('binds render and cancellation to sender identity and revokes both surfaces on renderer exit', async () => {
    const { service, handler } = setup()
    const render = vi
      .spyOn(service.markdown, 'render')
      .mockResolvedValue({ status: 'unavailable', reason: 'missing-provider' })
    const cancel = vi.spyOn(service.markdown, 'cancel')
    const revokeMarkdown = vi.spyOn(service.markdown, 'revokeOwner')
    const revokePanels = vi.spyOn(service.panels, 'revokeOwner')
    const sender = Object.assign(new EventEmitter(), { id: 17 })
    const args = { sessionId: 'block' }
    await handler('plugins:renderMarkdown')({ sender }, args)
    expect(render).toHaveBeenCalledWith('renderer:17', args)
    handler('plugins:cancelMarkdownRender')({ sender }, args)
    expect(cancel).toHaveBeenCalledWith('renderer:17', args)
    sender.emit('render-process-gone')
    expect(revokeMarkdown).toHaveBeenCalledWith('renderer:17')
    expect(revokePanels).toHaveBeenCalledWith('renderer:17')
  })

  it('refuses renders whose owner disappeared during startup', async () => {
    const { service, handler } = setup()
    let ready: () => void = () => undefined
    vi.spyOn(service, 'whenReady').mockImplementation(
      () =>
        new Promise((resolve) => {
          ready = resolve
        })
    )
    const render = vi.spyOn(service.markdown, 'render')
    const sender = Object.assign(new EventEmitter(), { id: 18 })
    const pending = handler('plugins:renderMarkdown')({ sender }, {})
    sender.emit('destroyed')
    ready()
    expect(await pending).toMatchObject({ status: 'error', code: 'stale-context' })
    expect(render).not.toHaveBeenCalled()
  })
})
