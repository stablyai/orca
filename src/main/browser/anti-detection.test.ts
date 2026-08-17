import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { ANTI_DETECTION_SCRIPT } from './anti-detection'
import { googleAuthUserAgent } from './browser-google-auth-ua'

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
    userAgent: string
    permissions: {
      query: (descriptor: { name: string }) => Promise<PermissionQueryResult>
    }
  }
  window: {
    chrome?: {
      runtime?: unknown
      csi?: () => unknown
      loadTimes?: () => unknown
    }
  }
}

function createContext(args: {
  nativeNotificationPermission: string
  requestedNotificationPermission: string
  userAgent?: string
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
    // Electron 43 exposes this native object before the anti-detection script runs.
    window: { chrome: {} },
    navigator: {
      userAgent:
        args.userAgent ??
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      plugins: [],
      languages: [],
      permissions: new Permissions()
    },
    Permissions,
    Notification
  } as AntiDetectionContext & Record<string, unknown>
}

describe('ANTI_DETECTION_SCRIPT', () => {
  it('does not expose Chrome globals under a Firefox identity', () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'denied',
      userAgent: googleAuthUserAgent()
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)

    expect(context.window.chrome).toBeUndefined()
    expect('chrome' in context.window).toBe(false)
  })

  it('keeps Chrome API stubs aligned with an ordinary Chrome page', () => {
    const context = createContext({
      nativeNotificationPermission: 'denied',
      requestedNotificationPermission: 'denied'
    })

    runInNewContext(ANTI_DETECTION_SCRIPT, context)

    expect(context.window.chrome?.runtime).toBeUndefined()
    expect(context.window.chrome?.csi).toBeTypeOf('function')
    expect(context.window.chrome?.loadTimes).toBeTypeOf('function')
  })

  it.each(['geolocation', 'idle-detection', 'midi', 'storage-access'])(
    'preserves the native denied state for %s',
    async (name) => {
      const context = createContext({
        nativeNotificationPermission: 'denied',
        requestedNotificationPermission: 'denied'
      })

      runInNewContext(ANTI_DETECTION_SCRIPT, context)

      await expect(context.navigator.permissions.query({ name })).resolves.toEqual({
        state: 'denied',
        onchange: null
      })
    }
  )

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
