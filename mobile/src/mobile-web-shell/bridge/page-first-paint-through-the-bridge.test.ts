// Use the real bridge pair so the paint report must cross the wire to release the shell’s cover.
import { describe, expect, it } from 'vitest'
import { createFakeRpcClient } from '../bridge-host-test-fakes'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { createRouteScreenPaintReporter } from './page-first-paint'

describe('the page telling the shell it has a frame', () => {
  it('posts after the first paint, and not before', async () => {
    const pair = createFakeBridgePortPair({ rpc: createFakeRpcClient() })
    await pair.flush()
    expect(pair.pagePaintCount()).toBe(0)

    const frames: (() => void)[] = []
    createRouteScreenPaintReporter(
      {
        requestFrame: (callback) => frames.push(callback),
        cancelFrame: () => undefined
      },
      () => {
        pair.client.notifyPagePainted()
      }
    )()
    while (frames.length > 0) {
      frames.shift()?.()
    }
    await pair.flush()
    expect(pair.pagePaintCount()).toBe(1)
  })

  it('costs the shell nothing to hear: no request, no subscription, no reply', async () => {
    const rpc = createFakeRpcClient()
    const pair = createFakeBridgePortPair({ rpc })
    await pair.flush()
    const framesToPage = pair.toPage.length
    pair.client.notifyPagePainted()
    await pair.flush()
    expect(rpc.requests).toHaveLength(0)
    expect(pair.toPage).toHaveLength(framesToPage)
  })
})
