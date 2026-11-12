import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'

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
vi.mock('../../../window/activation/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => mocks.background
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({ emitBrowserExtensionEvent: vi.fn() }))
vi.mock('../permissions/browser-extension-user-gesture', () => ({
  noteBrowserExtensionUserGesture: vi.fn()
}))

const { registerNotificationsNamespace } = await import('./notifications')
const { getBrowserExtensionNamespace } =
  await import('../api-runtime/browser-extension-namespace-registry')
const { emitBrowserExtensionEvent } = await import('../api-runtime/browser-extension-api-host')
const { noteBrowserExtensionUserGesture } =
  await import('../permissions/browser-extension-user-gesture')
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
  it('retires an activated notification while preserving click delivery and its successor', () => {
    const { caller } = notificationCaller('clicked')
    const sibling = { ...caller, extension: { ...caller.extension, id: 'b'.repeat(32) } }
    invoke(caller, 'create', ['clicked', options])
    invoke(sibling, 'create', ['sibling', options])
    const clicked = mocks.notifications[0]

    clicked.emit('click')

    expect(emitBrowserExtensionEvent).toHaveBeenCalledExactlyOnceWith(
      { session: caller.session, extensionId: caller.extension.id },
      'notifications',
      'onClicked',
      ['clicked']
    )
    expect(noteBrowserExtensionUserGesture).toHaveBeenCalledExactlyOnceWith(
      caller.session,
      caller.extension.id
    )
    expect(invoke(caller, 'getAll')).toEqual({})
    expect(invoke(caller, 'clear', ['clicked'])).toBe(false)
    expect(invoke(sibling, 'getAll')).toEqual({ sibling: true })
    expect(clicked.close).not.toHaveBeenCalled()
    expect(clicked.eventNames()).toEqual([])

    invoke(caller, 'create', ['clicked', options])
    clicked.emit('click')
    clicked.emit('close', {})
    expect(invoke(caller, 'getAll')).toEqual({ clicked: true })
    expect(emitBrowserExtensionEvent).toHaveBeenCalledTimes(1)
  })

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
})
