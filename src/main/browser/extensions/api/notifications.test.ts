import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../browser-extension-namespace-registry'

type TestNotification = EventEmitter & {
  close: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const notifications: TestNotification[] = []
  return { notifications, supported: true, background: false }
})
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Notification: class extends EventEmitter {
      static isSupported = () => mocks.supported
      close = vi.fn(() => this.emit('close', { reason: 'programmatic' }))
      show = vi.fn()
      constructor() {
        super()
        mocks.notifications.push(this)
      }
    },
    nativeImage: {}
  }
})
vi.mock('../../../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => mocks.background
}))
vi.mock('../browser-extension-api-host', () => ({ emitBrowserExtensionEvent: vi.fn() }))
vi.mock('./permissions', () => ({ noteBrowserExtensionUserGesture: vi.fn() }))

const { registerNotificationsNamespace, resolveNotificationIconPath } =
  await import('./notifications')
const { getBrowserExtensionNamespace } = await import('../browser-extension-namespace-registry')
const { emitBrowserExtensionEvent } = await import('../browser-extension-api-host')
registerNotificationsNamespace()

const extension = { id: 'a'.repeat(32), path: join('/ext', 'root') }

beforeEach(() => {
  mocks.notifications.length = 0
  mocks.supported = true
  mocks.background = false
  vi.clearAllMocks()
})

function notificationCaller(profileId: string): {
  caller: BrowserExtensionCaller
  extensions: EventEmitter
} {
  const extensions = new EventEmitter()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: notification methods only use the session's native extension event emitter.
  const session = Object.assign(new EventEmitter(), { extensions }) as Electron.Session
  return {
    caller: {
      browserProfileId: profileId,
      session,
      extension: {
        ...extension,
        name: 'Owner',
        url: `chrome-extension://${extension.id}/`,
        version: '1.0',
        manifest: { permissions: ['notifications'] }
      }
    },
    extensions
  }
}

function invoke(caller: BrowserExtensionCaller, method: string, args: unknown[] = []): unknown {
  const target = getBrowserExtensionNamespace('notifications')?.methods[method]
  if (!target) {
    throw new Error(`Missing notification method: ${method}`)
  }
  return target.invoke(caller, args)
}

const options = { type: 'basic', title: 'Notification', message: 'Retire with its extension' }

describe('notification extension ownership', () => {
  it('closes and forgets unloaded notifications while preserving sibling extensions and profiles', () => {
    const { caller, extensions } = notificationCaller('owner')
    const sibling = { ...caller, extension: { ...caller.extension, id: 'b'.repeat(32) } }
    const other = notificationCaller('other').caller
    for (const owner of [caller, sibling, other]) {
      invoke(owner, 'create', ['same-id', options])
    }
    expect(extensions.listenerCount('extension-unloaded')).toBe(1)
    const [retired, siblingNotification, otherNotification] = mocks.notifications
    extensions.emit('extension-unloaded', {}, caller.extension)
    expect(invoke(caller, 'getAll')).toEqual({})
    expect(invoke(sibling, 'getAll')).toEqual({ 'same-id': true })
    expect(invoke(other, 'getAll')).toEqual({ 'same-id': true })
    expect(retired.close).toHaveBeenCalledOnce()
    expect(siblingNotification.close).not.toHaveBeenCalled()
    expect(otherNotification.close).not.toHaveBeenCalled()
    expect(retired.eventNames()).toEqual([])
    expect(emitBrowserExtensionEvent).not.toHaveBeenCalled()
    invoke(caller, 'create', ['same-id', options])
    expect(extensions.listenerCount('extension-unloaded')).toBe(1)
    retired.emit('close', { reason: 'timedOut' })
    retired.emit('click')
    expect(invoke(caller, 'getAll')).toEqual({ 'same-id': true })
    expect(emitBrowserExtensionEvent).not.toHaveBeenCalled()
  })

  it('retires state even when native notifications are unavailable or presentation is suppressed', () => {
    for (const suppressed of ['unsupported', 'background']) {
      const { caller, extensions } = notificationCaller(suppressed)
      mocks.supported = suppressed !== 'unsupported'
      mocks.background = suppressed === 'background'
      invoke(caller, 'create', ['retired', options])
      expect(invoke(caller, 'getAll')).toEqual({ retired: true })
      extensions.emit('extension-unloaded', {}, caller.extension)
      expect(invoke(caller, 'getAll')).toEqual({})
    }
    expect(mocks.notifications).toHaveLength(0)
  })

  it('keeps live replacement, updates, native dismissal and explicit clear behavior', () => {
    const { caller } = notificationCaller('live')
    invoke(caller, 'create', ['live', options])
    const original = mocks.notifications[0]
    invoke(caller, 'create', ['live', { ...options, message: 'replacement' }])
    expect(original.close).toHaveBeenCalledOnce()
    expect(invoke(caller, 'getAll')).toEqual({ live: true })
    expect(invoke(caller, 'update', ['live', { message: 'updated' }])).toBe(true)
    expect(mocks.notifications[1].close).toHaveBeenCalledOnce()
    mocks.notifications[2].emit('close', { reason: 'timedOut' })
    expect(invoke(caller, 'getAll')).toEqual({})
    expect(emitBrowserExtensionEvent).toHaveBeenLastCalledWith(
      { session: caller.session, extensionId: caller.extension.id },
      'notifications',
      'onClosed',
      ['live', false]
    )
    invoke(caller, 'create', ['clear', options])
    expect(invoke(caller, 'clear', ['clear'])).toBe(true)
    expect(mocks.notifications[3].close).toHaveBeenCalledOnce()
    expect(invoke(caller, 'clear', ['clear'])).toBe(false)
  })
})

describe('resolveNotificationIconPath', () => {
  it("resolves the extension's own icons, relative or absolute", () => {
    const icon = join(extension.path, 'icons', 'bell.png')
    expect(resolveNotificationIconPath(extension, 'icons/bell.png')).toBe(icon)
    expect(
      resolveNotificationIconPath(extension, `chrome-extension://${extension.id}/icons/bell.png`)
    ).toBe(icon)
  })

  it('refuses icons from the web, other extensions, or outside the package', () => {
    expect(resolveNotificationIconPath(extension, 'https://site.test/bell.png')).toBeNull()
    expect(
      resolveNotificationIconPath(extension, `chrome-extension://${'b'.repeat(32)}/bell.png`)
    ).toBeNull()
    expect(resolveNotificationIconPath(extension, 'icons%2F..%2F..%2Fsecret.png')).toBeNull()
  })
})
