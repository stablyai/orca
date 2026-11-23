import { expect, it, vi } from 'vitest'
import { readShellSession } from '../client-state/bridge-client-session'
import { BRIDGE_STORE_VERB } from '../native-capabilities/bridge-store-verb'
import { createBridgeInitFrame } from '../protocol/bridge-init-frame'
import { createPageDeviceStore } from './page-device-store'

function init(sessionId: string) {
  return readShellSession(
    createBridgeInitFrame({
      sessionId,
      buildId: '0'.repeat(64),
      connection: {
        state: 'connected',
        reconnectAttempt: 0,
        lastConnectedAt: 0,
        lastInboundAt: null,
        generation: 1
      },
      route: { pathname: '/settings' },
      pageRoutes: ['/settings'],
      granted: [BRIDGE_STORE_VERB],
      host: {
        id: 'same-desktop',
        name: 'Fixture',
        endpoint: 'ws://fixture.invalid',
        lastConnected: 0
      },
      storage: {}
    })
  )
}

it('drops a queued store write when a re-pair reuses the desktop namespace', async () => {
  vi.useFakeTimers()
  try {
    let session = init('old-page')
    let room = 0
    const dispatched: unknown[] = []
    const client = {
      getShellSession: () => session,
      nativeRequestRoom: () => room,
      callNativeVerb: async (_verb: string, params: unknown) => {
        dispatched.push(params)
        return {
          ok: true as const,
          id: 'fixture',
          _meta: { runtimeId: 'fixture' },
          result: { written: true }
        }
      }
    }
    const old = createPageDeviceStore(client)
    const pending = old.write('cache', [{ key: 'i18n-catalog:ru', value: 'old' }])
    session = init('new-page')
    room = 64
    await vi.runOnlyPendingTimersAsync()
    await expect(pending).resolves.toEqual({ written: false, refusal: 'unavailable' })
    expect(dispatched).toEqual([])
    await expect(
      createPageDeviceStore(client).write('cache', [{ key: 'i18n-catalog:ru', value: 'new' }])
    ).resolves.toEqual({ written: true })
    expect(dispatched).toEqual([
      {
        action: 'write',
        table: 'cache',
        ops: [{ key: 'i18n-catalog:ru', value: 'new' }]
      }
    ])
  } finally {
    vi.useRealTimers()
  }
})
