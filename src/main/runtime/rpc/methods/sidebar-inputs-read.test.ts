import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../../shared/mobile-bridge-frame-bytes'
import { SIDEBAR_INPUTS_PAGE_MAX_BYTES } from '../../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SidebarInputsFeed } from '../../sidebar-inputs/sidebar-inputs-feed'
import { testDomain } from '../../sidebar-inputs/sidebar-inputs-feed.test-fixture'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SIDEBAR_INPUT_METHODS } from './sidebar-inputs'

function makeHost() {
  // Rows far larger than one page, so the first reply is a full page.
  const rows = testDomain(
    'rows',
    Object.fromEntries(
      Array.from({ length: 3_000 }, (_, index) => [`row-${index}`, 'r'.padEnd(300, '中')])
    )
  )
  const feed = new SidebarInputsFeed(
    () => [rows.domain],
    () => {}
  )
  const cleanups = new Map<string, () => void>()
  const fake = {
    getRuntimeId: () => 'test-runtime',
    sidebarInputsFeed: feed,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sidebarInputs.read reads only the members above.
  const runtime = fake as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SIDEBAR_INPUT_METHODS })
  let requestId = 0
  const read = (context: RpcDispatchStreamingOptions) => {
    const request: RpcRequest = {
      id: `req-${++requestId}`,
      authToken: 'tok',
      method: 'sidebarInputs.read',
      params: { maxBytes: SIDEBAR_INPUTS_PAGE_MAX_BYTES }
    }
    return dispatcher.dispatch(request, context)
  }
  return { rows, read, cleanups }
}

describe('sidebarInputs.read', () => {
  it('serves the host’s own phone a page that fits its bridge frame with the RPC envelope', async () => {
    const host = makeHost()
    const response = await host.read({ clientKind: 'mobile', connectionId: 'conn-1' })
    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'snapshot', next: expect.any(String) }
    })
    const frame = Buffer.byteLength(JSON.stringify(response), 'utf8')
    expect(frame).toBeGreaterThan(SIDEBAR_INPUTS_PAGE_MAX_BYTES * 0.9)
    expect(frame).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
  })

  it('refuses a delegated phone, a paired desktop and a caller without a connection', async () => {
    const host = makeHost()
    for (const context of [
      { clientKind: 'mobile', connectionId: 'conn-1', pairedDeviceParentId: 'desktop-device' },
      { clientKind: 'runtime', connectionId: 'conn-1' },
      { clientKind: 'mobile' }
    ] satisfies RpcDispatchStreamingOptions[]) {
      expect(await host.read(context)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(host.rows.reads()).toBe(0)
  })

  it('subscribes a connection on its first read and releases it when the connection closes', async () => {
    const host = makeHost()
    await host.read({ clientKind: 'mobile', connectionId: 'conn-1' })
    await host.read({ clientKind: 'mobile', connectionId: 'conn-1' })
    expect([...host.cleanups.keys()]).toEqual(['sidebar-inputs-feed-conn-1'])
    expect(host.rows.watchers()).toBe(1)
    host.cleanups.get('sidebar-inputs-feed-conn-1')?.()
    expect(host.rows.watchers()).toBe(0)
  })

  it('does not subscribe a connection that closed before its read ran', async () => {
    const host = makeHost()
    const closed = new AbortController()
    closed.abort()
    const response = await host.read({
      clientKind: 'mobile',
      connectionId: 'conn-1',
      signal: closed.signal
    })
    expect(response).toMatchObject({ ok: false })
    expect(host.cleanups.size).toBe(0)
    expect(host.rows.watchers()).toBe(0)
  })
})
