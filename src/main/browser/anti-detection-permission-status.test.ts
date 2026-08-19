import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { ANTI_DETECTION_SCRIPT } from './anti-detection'

type PermissionQueryResult = EventTarget & {
  state: string
  onchange: EventListener | null
  marker: string
}

type PermissionStatusConstructor = {
  new (): PermissionQueryResult
  prototype: PermissionQueryResult
}

type AntiDetectionContext = {
  Notification: {
    permission: string
    requestPermission: (callback?: (permission: string) => void) => Promise<string>
  }
  PermissionStatus: PermissionStatusConstructor
  dispatchPermissionChange: (name: string) => void
  navigator: {
    permissions: {
      query: (descriptor: { name: string }) => Promise<PermissionQueryResult>
    }
  }
}

function createContext(args: {
  nativeNotificationPermission: string
  requestedNotificationPermission: string
  rejectedPermissions?: string[]
}): AntiDetectionContext & Record<string, unknown> {
  class PermissionStatus extends EventTarget {
    #state = 'denied'
    #onchange: EventListener | null = null
    marker = 'real-status'

    get state(): string {
      return this.#state
    }

    get onchange(): EventListener | null {
      return this.#onchange
    }

    set onchange(listener: EventListener | null) {
      if (this.#onchange) {
        super.removeEventListener('change', this.#onchange)
      }
      this.#onchange = typeof listener === 'function' ? listener : null
      if (this.#onchange) {
        super.addEventListener('change', this.#onchange)
      }
    }
  }

  const statuses = new Map<string, PermissionStatus[]>()
  const rejectedPermissions = new Set(args.rejectedPermissions)

  class Permissions {
    query(descriptor: { name: string }): Promise<PermissionStatus> {
      if (rejectedPermissions.has(descriptor.name)) {
        return Promise.reject(new Error('Unsupported permission'))
      }
      const status = new PermissionStatus()
      const permissionStatuses = statuses.get(descriptor.name) ?? []
      permissionStatuses.push(status)
      statuses.set(descriptor.name, permissionStatuses)
      return Promise.resolve(status)
    }
  }

  const Notification = {
    permission: args.nativeNotificationPermission,
    requestPermission(callback?: (permission: string) => void): Promise<string> {
      callback?.(args.requestedNotificationPermission)
      return Promise.resolve(args.requestedNotificationPermission)
    }
  }
  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    get: () => args.nativeNotificationPermission
  })

  return {
    Date,
    Event,
    EventTarget,
    Object,
    Promise,
    Set,
    performance: { now: () => 0 },
    // Why: the script's Firefox gate reads navigator.userAgent, so a non-Firefox UA keeps these
    // tests on the ordinary-page path where the PermissionStatus override applies.
    window: { chrome: {} },
    navigator: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      plugins: [],
      languages: [],
      permissions: new Permissions()
    },
    Permissions,
    PermissionStatus,
    Notification,
    dispatchPermissionChange(name: string): void {
      for (const status of statuses.get(name) ?? []) {
        status.dispatchEvent(new Event('change'))
      }
    }
  } as AntiDetectionContext & Record<string, unknown>
}

describe('ANTI_DETECTION_SCRIPT — PermissionStatus', () => {
  it('keeps an existing notification status current after permission changes', async () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)
    const status = await context.navigator.permissions.query({ name: 'notifications' })

    expect(context.Notification.permission).toBe('default')
    expect(status.state).toBe('prompt')

    await expect(context.Notification.requestPermission()).resolves.toBe('granted')

    expect(context.Notification.permission).toBe('granted')
    expect(status.state).toBe('granted')
  })

  it('preserves native PermissionStatus identity and methods', async () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)
    const status = await context.navigator.permissions.query({ name: 'camera' })
    const expectedSource = Function.prototype.toString.call(
      context.PermissionStatus.prototype.addEventListener
    )

    expect(status).toBeInstanceOf(context.PermissionStatus)
    expect(status.state).toBe('prompt')
    expect(status.constructor.name).toBe('PermissionStatus')
    expect(status.marker).toBe('real-status')
    expect(status.addEventListener.name).toBe('addEventListener')
    expect(status.addEventListener).toBe(status.addEventListener)
    expect(Function.prototype.toString.call(status.addEventListener)).toBe(expectedSource)
    expect(expectedSource).toContain('addEventListener')
  })

  it('delivers change events through the returned status with the overridden state', async () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)
    const status = await context.navigator.permissions.query({ name: 'notifications' })
    const events: { receiver: EventTarget; target: EventTarget | null; state: string }[] = []
    const recordEvent = function (this: EventTarget, event: Event): void {
      events.push({
        receiver: this,
        target: event.target,
        state: (event.target as PermissionQueryResult).state
      })
    }

    status.addEventListener('change', recordEvent)
    expect(() => {
      status.onchange = function (this: EventTarget, event): void {
        recordEvent.call(this, event)
      }
    }).not.toThrow()

    await context.Notification.requestPermission()
    context.dispatchPermissionChange('notifications')

    expect(events).toHaveLength(2)
    expect(events).toEqual([
      { receiver: status, target: status, state: 'granted' },
      { receiver: status, target: status, state: 'granted' }
    ])
  })

  // Why: 'camera' rather than 'storage-access' — #14685 narrowed the intercepted set to
  // camera/microphone, so a name outside it falls through to the real query and never reaches
  // the fallback at all.
  it('uses a non-enumerable EventTarget fallback when the native query rejects', async () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'granted',
      rejectedPermissions: ['camera']
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)
    const status = await context.navigator.permissions.query({ name: 'camera' })

    expect(status).toBeInstanceOf(EventTarget)
    expect(status).not.toBeInstanceOf(context.PermissionStatus)
    expect(status.state).toBe('prompt')
    expect(Object.keys(status)).toEqual([])
  })
})
