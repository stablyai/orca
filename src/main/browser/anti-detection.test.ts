import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { ANTI_DETECTION_SCRIPT } from './anti-detection'

type PermissionQueryResult = {
  state: string
  onchange: null
}

type AntiDetectionContext = {
  Notification: {
    permission: string
    requestPermission: (callback?: (permission: string) => void) => Promise<string>
  }
  navigator: {
    permissions: {
      query: (descriptor: { name: string }) => Promise<PermissionQueryResult>
    }
  }
}

function createContext(args: {
  nativeNotificationPermission: string
  requestedNotificationPermission: string
}): AntiDetectionContext & Record<string, unknown> {
  class Permissions {
    query(): Promise<PermissionQueryResult> {
      return Promise.resolve({ state: 'denied', onchange: null })
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
    Object,
    Promise,
    Set,
    performance: { now: () => 0 },
    window: {},
    navigator: {
      plugins: [],
      languages: [],
      permissions: new Permissions()
    },
    Permissions,
    Notification
  } as AntiDetectionContext & Record<string, unknown>
}

describe('ANTI_DETECTION_SCRIPT', () => {
  it('reports notification permission as granted after a site permission request succeeds', async () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)

    expect(context.Notification.permission).toBe('default')
    await expect(context.navigator.permissions.query({ name: 'notifications' })).resolves.toEqual({
      state: 'prompt',
      onchange: null
    })

    await expect(context.Notification.requestPermission()).resolves.toBe('granted')

    expect(context.Notification.permission).toBe('granted')
    await expect(context.navigator.permissions.query({ name: 'notifications' })).resolves.toEqual({
      state: 'granted',
      onchange: null
    })
  })

  it('preserves notification permission when Electron already reports a grant', async () => {
    const context = createContext({
      nativeNotificationPermission: 'granted',
      requestedNotificationPermission: 'granted'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)

    expect(context.Notification.permission).toBe('granted')
    await expect(context.navigator.permissions.query({ name: 'notifications' })).resolves.toEqual({
      state: 'granted',
      onchange: null
    })
  })
})
