/**
 * The paint report end to end, driven through the real port pair rather than a mocked host, because
 * what is worth proving is that the page's post reaches the shell's cover over a real frame.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeRpcClient } from '../bridge-host-test-fakes'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { createRouteScreenPaintReporter } from './page-first-paint'

describe('the page telling the shell it has a frame', () => {
  it('posts after the first paint, and not before', async () => {
    const pair = createFakeBridgePortPair({ rpc: createFakeRpcClient() })
    await pair.flush()
    expect(pair.pagePaintCount()).toBe(0)

    // The two frames the entry waits out, drained by hand so "after the paint" is a step.
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

  it('is reported by the page entry, from the effect that runs after the tree commits', () => {
    // The one call site, pinned: every test above drives the client directly, so a deleted line in
    // the entry would leave a shell covering a page that has painted and will never say so.
    const entry = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'web-entry', 'index.tsx'),
      'utf8'
    )
    expect(entry).toContain('createRouteScreenPaintReporter(')
    expect(entry).toContain('client.notifyPagePainted()')
    // Handed to the route screen rather than called from the wrapper's own effect, which commits
    // while the route's chunk is still arriving and the body is empty.
    expect(entry).toContain('RouteScreenPaintProvider')
    expect(entry).not.toMatch(
      /stampPageMountState\(target, 'mounted'\)\s*\n\s*reportRouteScreenPaint/
    )
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
