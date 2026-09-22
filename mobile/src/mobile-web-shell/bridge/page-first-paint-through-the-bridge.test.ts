/**
 * The paint report end to end, and the three pairings it has to survive: a shell that never
 * advertised it, a page that never declared it, and two halves that did both.
 *
 * Driven through the real port pair rather than a mocked host, because what is worth proving is
 * that each half reads the other's word off a real frame rather than assuming it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeRpcClient } from '../bridge-host-test-fakes'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import { createRouteScreenPaintReporter } from './page-first-paint'

/** One `init` frame with one name taken out of `accepts`, which is what an older shell sends. */
function stripAccept(json: string, name: string): string {
  const frame: unknown = JSON.parse(json)
  if (typeof frame !== 'object' || frame === null || !('type' in frame)) {
    return json
  }
  const record: Record<string, unknown> = { ...frame }
  if (record.type !== 'init' || !Array.isArray(record.accepts)) {
    return json
  }
  record.accepts = record.accepts.filter((entry) => entry !== name)
  return JSON.stringify(record)
}

describe('the page telling the shell it has a frame', () => {
  it('new shell, new page: declares on ready and posts after the first paint', async () => {
    const pair = createFakeBridgePortPair({ rpc: createFakeRpcClient() })
    await pair.flush()
    expect(pair.pageReports()).toEqual([[BRIDGE_PAGE_PAINTED]])
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

  it('old shell, new page: posts nothing, so no shell is left refusing a frame', async () => {
    // Stands for every shell installed before this change: `notify` is a closed union there, so an
    // unasked-for report is an error frame per mount rather than a dropped one.
    const pair = createFakeBridgePortPair({
      rpc: createFakeRpcClient(),
      rewriteToPage: (json) => stripAccept(json, BRIDGE_PAGE_PAINTED)
    })
    await pair.flush()
    expect(pair.client.getShellSession()?.accepts).not.toContain(BRIDGE_PAGE_PAINTED)
    const framesToShell = pair.toShell.length
    pair.client.notifyPagePainted()
    await pair.flush()
    expect(pair.toShell).toHaveLength(framesToShell)
    expect(pair.pagePaintCount()).toBe(0)
    expect(pair.hostDiagnostics).not.toContainEqual(
      expect.objectContaining({ refusal: 'unrecognised-message' })
    )
  })

  it('advertises the report in init, which is what the page reads before posting one', async () => {
    const pair = createFakeBridgePortPair({ rpc: createFakeRpcClient() })
    await pair.flush()
    expect(pair.client.getShellSession()?.accepts).toContain(BRIDGE_PAGE_PAINTED)
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
