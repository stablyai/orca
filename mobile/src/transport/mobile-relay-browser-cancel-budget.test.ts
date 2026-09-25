import { describe, expect, it } from 'vitest'
import { RuntimeBrowserScreencastController } from '../../../src/main/runtime/runtime-browser-screencast-controller'
import type { RuntimeBrowserCommands } from '../../../src/main/runtime/orca-runtime-browser'
import type { BrowserScreencastResult } from '../../../src/shared/runtime-types'
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
    let sendBinary: (bytes: Uint8Array) => boolean | void = () => false
    let hostRun: Promise<void> | undefined
    const methods: string[] = []
    const cleanup = (id: string): void => {
      const release = subscriptions.get(id)
      subscriptions.delete(id)
      void release?.()
    }
    const host = new RuntimeBrowserScreencastController({
      getCommands: () =>
        ({
          browserScreencast: async (_params, stream) => {
            sendBinary = stream.sendBinary
            return {
              subscriptionId: 'server-stream',
              ready: { type: 'ready', subscriptionId: 'server-stream', browserPageId: 'page' },
              session: {
                done: done.promise,
                stop: () => {
                  stopped = true
                  done.resolve()
                }
              },
              flushPendingFrame: () => {}
            }
          }
        }) as RuntimeBrowserCommands,
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
        if (request.method === 'browser.screencast' && (request.params as { page?: string }).page) {
          hostRun = host.start(request.params as Parameters<typeof host.start>[0], {
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
          })
        } else if (request.method === 'browser.screencast.unsubscribe') {
          cleanup((request.params as { subscriptionId: string }).subscriptionId)
        }
        return true
      }
    })
    const cancel = streams.subscribe('browser.screencast', { page: 'page' }, () => {})
    try {
      const response = await ready.promise
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
        frameSends: 0,
        frameBytes: 0
      })
      expect(methods).toEqual(['browser.screencast', 'browser.screencast.unsubscribe'])
    } finally {
      cleanup('server-stream')
      await hostRun
      streams.clear()
    }
  })
})
