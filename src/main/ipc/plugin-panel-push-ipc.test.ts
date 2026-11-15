import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

import type { PluginService } from '../plugins/plugin-service'
import { registerPluginPanelPushHandlers } from './plugin-panel-push-ipc'

it("keeps the sender's 'destroyed' listeners bounded across panel push sessions", async () => {
  const stop = vi.fn()
  const pluginService = {
    whenReady: async () => {},
    panels: { sessionCaller: () => ({ caller: {}, pluginKey: 'acme.board' }) },
    panelBridge: { open: () => stop }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the push handlers read only whenReady, panels.sessionCaller and panelBridge.open.
  registerPluginPanelPushHandlers(pluginService as unknown as PluginService)
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    send: vi.fn()
  })
  const event = { sender }

  for (let index = 0; index < 25; index++) {
    const args = { sessionToken: `session-${index}`.padEnd(32, '0') }
    await expect(handlers.get('plugins:openPanelPush')?.(event, args)).resolves.toBe(true)
    await handlers.get('plugins:openPanelPush')?.(event, args)
    handlers.get('plugins:closePanelPush')?.(event, args)
    expect(sender.listenerCount('destroyed')).toBe(0)
  }
  expect(stop).toHaveBeenCalledTimes(50)
})
