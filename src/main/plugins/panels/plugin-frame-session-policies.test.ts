import { describe, expect, it, vi } from 'vitest'
import { pluginFrameKey } from '../../../shared/plugins/frames/plugin-frame-guest'
import { applyPluginFrameSessionPolicies } from './plugin-frame-session-policies'

const KEY = pluginFrameKey('acme.policy')

function fakeSession() {
  type Handler = (...args: unknown[]) => void
  const handlers = new Map<string, Handler>()
  const slots: {
    requestHandler: Handler | null
    checkHandler: ((...args: unknown[]) => boolean) | null
    beforeRequest: Handler | null
  } = { requestHandler: null, checkHandler: null, beforeRequest: null }
  const session = {
    handlers,
    ...slots,
    webRequest: {
      onBeforeRequest: (handler: (...args: unknown[]) => void) => (session.beforeRequest = handler)
    },
    setPermissionRequestHandler: (handler: (...args: unknown[]) => void) =>
      (session.requestHandler = handler),
    setPermissionCheckHandler: (handler: (...args: unknown[]) => boolean) =>
      (session.checkHandler = handler),
    setDevicePermissionHandler: vi.fn(),
    on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
    setSpellCheckerEnabled: vi.fn()
  }
  return session
}

describe('plugin frame session policies', () => {
  it('denies every permission, clipboard writes included', () => {
    const session = fakeSession()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer uses only the members faked here.
    applyPluginFrameSessionPolicies(session as never, KEY)
    for (const permission of ['clipboard-sanitized-write', 'clipboard-read', 'media', 'hid']) {
      const callback = vi.fn()
      session.requestHandler?.({}, permission, callback)
      expect(callback).toHaveBeenCalledWith(false)
      expect(session.checkHandler?.({}, permission)).toBe(false)
    }
  })

  it('cancels every device chooser and download, and cancels off-origin requests', () => {
    const session = fakeSession()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    applyPluginFrameSessionPolicies(session as never, KEY)
    for (const [name, args] of [
      ['select-hid-device', [{}]],
      ['select-serial-port', [[], {}]],
      ['select-usb-device', [{}]]
    ] as const) {
      const event = { preventDefault: vi.fn() }
      const callback = vi.fn()
      session.handlers.get(name)?.(event, ...args, callback)
      expect(event.preventDefault, name).toHaveBeenCalled()
      expect(callback, name).toHaveBeenCalled()
    }
    const download = { preventDefault: vi.fn() }
    session.handlers.get('will-download')?.(download)
    expect(download.preventDefault).toHaveBeenCalled()
    const answer = vi.fn()
    session.beforeRequest?.({ url: 'http://127.0.0.1:9/' }, answer)
    expect(answer).toHaveBeenCalledWith({ cancel: true })
  })
})
