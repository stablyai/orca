import { describe, expect, it } from 'vitest'
import { RuntimeBrowserScreencastController } from '../../../src/main/runtime/runtime-browser-screencast-controller'
import type { BrowserScreencastResult } from '../../../src/shared/runtime-types'
import type { RpcBinarySender } from '../../../src/main/runtime/rpc/rpc-binary-sender'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import type { RpcResponse } from './types'

describe('relay browser cancellation resource budget', () => {
  it.each([false, true])('stops host frames when cancellation precedes ready=%s', async (early) => {
    const subscriptions = new Map<string, () => void | Promise<void>>()
    const done = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<RpcResponse>()
    let sequence = 0
    let stopped = false
    let frameSends = 0
    let frameBytes = 0
    let sendBinary: RpcBinarySender = () => false
    let hostRun: Promise<void> | undefined
    const methods: string[] = []
    const cleanup = (id: string): void => {
      const release = subscriptions.get(id)
      subscriptions.delete(id)
      void release?.()
    }
    const host = new RuntimeBrowserScreencastController({
      getCommands: () => ({
        browserScreencast: async (_params, stream) => {
          sendBinary = stream.sendBinary
          return {
            subscriptionId: 'server-stream',
            ready: {
              type: 'ready',
              subscriptionId: 'server-stream',
              browserPageId: 'page',
              format: 'jpeg',
              tab: {
                browserPageId: 'page',
                index: 0,
                url: 'about:blank',
                title: 'Browser',
                active: true
              }
            },
            session: {
              done: done.promise,
              stop: () => {
                stopped = true
                done.resolve()
              },
              updateViewport: async () => {}
            },
            flushPendingFrame: () => {}
          }
        }
      }),
      registerSubscriptionCleanup: (id, release) => subscriptions.set(id, release),
      cleanupSubscription: cleanup,
      getDriver: () => ({ kind: 'idle' }),
      setDriver: () => {},
      notifyRemoteViewersChanged: () => {}
    })
    const streams = new MobileRelayRpcStreams({
      nextId: () => `request-${++sequence}`,
      waitForConnected: async () => {},
      sendFrame: (request) => {
        methods.push(request.method)
        if (request.method === 'browser.screencast') {
          expect(request.params).toEqual({ page: 'page' })
          hostRun = host.start(
            { page: 'page' },
            {
              connectionId: 'relay-connection',
              sendBinary: (bytes) => {
                frameSends++
                frameBytes += bytes.byteLength
                return true
              },
              emit: (result: BrowserScreencastResult) => {
                if (result.type === 'ready') {
                  ready.resolve({
                    id: request.id,
                    ok: true,
                    streaming: true,
                    result,
                    _meta: { runtimeId: 'host' }
                  })
                }
              }
            }
          )
        } else if (request.method === 'browser.screencast.unsubscribe') {
          expect(request.params).toEqual({ subscriptionId: 'server-stream' })
          cleanup('server-stream')
        }
        return true
      }
    })
    const cancel = streams.subscribe('browser.screencast', { page: 'page' }, () => {})
    try {
      const response = await ready.promise
      expect(sendBinary(new Uint8Array(65_536))).toBe(true)
      expect({ frameSends, frameBytes }).toEqual({ frameSends: 1, frameBytes: 65_536 })
      if (early) {
        cancel()
      }
      streams.handleResponse(response)
      if (!early) {
        cancel()
      }
      for (let frame = 0; frame < 100; frame++) {
        if (!stopped) {
          sendBinary(new Uint8Array(65_536))
        }
      }
      expect({ stopped, subscriptions: subscriptions.size, frameSends, frameBytes }).toEqual({
        stopped: true,
        subscriptions: 0,
        frameSends: 1,
        frameBytes: 65_536
      })
      expect(methods).toEqual(['browser.screencast', 'browser.screencast.unsubscribe'])
    } finally {
      cleanup('server-stream')
      await hostRun
      streams.clear()
    }
  })
})
