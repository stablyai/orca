/**
 * The paint report end to end: the page's `ready` declares it, the shell hears the declaration,
 * and the report the page posts after its first frame lands on the shell's session.
 *
 * Driven through the real port pair rather than a mocked host, because the thing worth proving is
 * that this pair speaks about the same document: the declaration is read off a `ready`, and the
 * report is refused before one.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeRpcClient } from '../bridge-host-test-fakes'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'
import { reportAfterFirstPaint } from './page-first-paint'

describe('the page telling the shell it has a frame', () => {
  it('declares the report on ready and posts it after the first paint', async () => {
    const pair = createFakeBridgePortPair({ rpc: createFakeRpcClient() })
    await pair.flush()
    expect(pair.pageReports()).toEqual([[BRIDGE_PAGE_PAINTED]])
    expect(pair.pagePaintCount()).toBe(0)

    // The two frames the entry waits out, drained by hand so "after the paint" is a step.
    const frames: (() => void)[] = []
    reportAfterFirstPaint(
      (callback) => {
        frames.push(callback)
      },
      () => {
        pair.client.notifyPagePainted()
      }
    )
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
    expect(entry).toContain('reportAfterFirstPaint(')
    expect(entry).toContain('client.notifyPagePainted()')
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
