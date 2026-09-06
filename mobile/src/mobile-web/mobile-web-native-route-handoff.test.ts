import { describe, expect, it, vi } from 'vitest'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'
import {
  completeMobileWebNativeRouteHandoffAfterResponse,
  MobileWebNativeRouteHandoff
} from './mobile-web-native-route-handoff'

describe('mobile web native route handoff', () => {
  it('posts the broker response before scheduling navigation', async () => {
    const events: string[] = []
    const handoff = new MobileWebNativeRouteHandoff()
    const requestId = 'R'.repeat(22)
    let resolveDeactivation: (() => void) | undefined
    const deactivation = new Promise<void>((resolve) => {
      resolveDeactivation = resolve
    })
    const { broker } = createMobileWebBrokerFixture({
      isConnected: () => false,
      navigationAuthority: {
        route(destination, routedRequestId) {
          events.push('record')
          if (destination === 'terminalSettings') {
            handoff.record(routedRequestId, destination)
          }
        },
        reconnect: vi.fn(),
        removeHost: vi.fn()
      },
      terminalClientId: 'native-only-device',
      randomBytes: (length) => new Uint8Array(length),
      postMessage(message) {
        expect(message).toMatchObject({ type: 'response', requestId, status: 'success' })
        events.push('response')
      }
    })

    await broker.handle(
      mobileWebBridgeRequestMessage({
        requestId,
        capability: 'navigation',
        operation: 'route',
        payload: { destination: 'terminalSettings' }
      })
    )

    let scheduled: (() => Promise<void>) | undefined
    expect(events).toEqual(['record', 'response'])
    expect(
      completeMobileWebNativeRouteHandoffAfterResponse({
        handoff,
        requestId,
        deactivateSessionView: () => {
          events.push('deactivate')
          return deactivation
        },
        setHostedViewActive: (active) => events.push(`active:${active}`),
        navigate: () => events.push('navigate'),
        schedule(callback) {
          expect(handoff.consume(requestId)).toBeNull()
          events.push('schedule')
          scheduled = callback
        }
      })
    ).toBe(true)
    expect(events).toEqual(['record', 'response', 'schedule'])
    const completion = scheduled?.()
    expect(events).toEqual(['record', 'response', 'schedule', 'active:false', 'deactivate'])
    resolveDeactivation?.()
    await completion
    expect(events).toEqual([
      'record',
      'response',
      'schedule',
      'active:false',
      'deactivate',
      'navigate'
    ])
    broker.dispose()
  })

  it('reactivates the hosted view when native deactivation fails', async () => {
    const events: string[] = []
    const handoff = new MobileWebNativeRouteHandoff()
    const requestId = 'F'.repeat(22)
    handoff.record(requestId, 'terminalSettings')
    let scheduled: (() => Promise<void>) | undefined

    completeMobileWebNativeRouteHandoffAfterResponse({
      handoff,
      requestId,
      deactivateSessionView: async () => {
        events.push('deactivate')
        throw new Error('native failure')
      },
      setHostedViewActive: (active) => events.push(`active:${active}`),
      navigate: () => events.push('navigate'),
      onFailure: () => events.push('failure'),
      schedule: (callback) => {
        scheduled = callback
      }
    })

    await scheduled?.()
    expect(events).toEqual(['active:false', 'deactivate', 'active:true', 'failure'])
  })
})
