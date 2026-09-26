import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerMobileRelaySettingsHandlers } from './mobile-relay-settings'

type Sender = { sender: { isDestroyed: () => boolean; getType: () => string } }
const handlers = vi.hoisted(() => new Map<string, (event: Sender, input: unknown) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: Sender, input: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
const configure = vi.fn()
const settings = { url: 'https://relay.example.com', accessKey: 'k'.repeat(64) }
const windowSender = { sender: { isDestroyed: () => false, getType: () => 'window' } }
beforeEach(() => {
  handlers.clear()
  configure.mockReset()
  registerMobileRelaySettingsHandlers(configure)
})

describe('mobile Relay settings IPC', () => {
  it('accepts a desktop save and removal', () => {
    const invoke = handlers.get('mobile:configureSelfHostedRelay')!
    expect(invoke(windowSender, settings)).toEqual({ ok: true })
    expect(configure).toHaveBeenCalledWith(settings)
    expect(invoke(windowSender, null)).toEqual({ ok: true })
    expect(configure).toHaveBeenLastCalledWith(null)
  })

  it('rejects webviews and malformed input without writing settings', () => {
    const invoke = handlers.get('mobile:configureSelfHostedRelay')!
    expect(
      invoke({ sender: { ...windowSender.sender, getType: () => 'webview' } }, settings)
    ).toMatchObject({ ok: false })
    expect(invoke(windowSender, { url: settings.url })).toMatchObject({ ok: false })
    expect(configure).not.toHaveBeenCalled()
  })

  it('returns a save failure instead of acknowledging a configuration that did not persist', () => {
    configure.mockImplementation(() => {
      throw new Error('Unlock the OS keyring.')
    })
    expect(handlers.get('mobile:configureSelfHostedRelay')!(windowSender, settings)).toEqual({
      ok: false,
      message: 'Unlock the OS keyring.'
    })
  })
})
