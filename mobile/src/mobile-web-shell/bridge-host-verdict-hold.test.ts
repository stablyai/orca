import { describe, expect, it } from 'vitest'
import type { HostStatusReply } from '../transport/host-status-reply-schema'
import { bridgeId, clientFrame, flushBridge } from './bridge-host-test-fakes'
import { harness, subscribeFrame } from './bridge-host-test-harness'

const PROVEN: HostStatusReply = { protocolVersion: 10, minCompatibleMobileVersion: 1 }

// A cached page renders before this connection's verdict; nothing it sends may reach the desktop until then.
describe('the connection verdict hold', () => {
  function heldBridge() {
    const verdict: { status: HostStatusReply | null } = { status: null }
    const bridge = harness({ ready: true, readHostStatus: () => verdict.status })
    return { bridge, verdict }
  }

  it('reports handshaking and keeps requests and streams off the desktop until the verdict', async () => {
    const { bridge } = heldBridge()
    const init = bridge.last()
    expect(init).toMatchObject({ type: 'init', connection: { state: 'handshaking' } })

    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(1), method: 'worktree.ps', params: {} })
    )
    bridge.host.receive(subscribeFrame(bridgeId(2)))
    // The PDF viewer downloads the file from the desktop, so it waits too.
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(3), method: 'native.pdf.view', params: {} })
    )
    // status.get is how the page learns the verdict, so it alone reaches the desktop.
    bridge.host.receive(clientFrame({ type: 'request', id: bridgeId(4), method: 'status.get' }))
    // The device store never leaves the phone, so a cached page can read it before (or without) a verdict.
    const storeRead = { action: 'read', table: 'cache', keys: ['host-list'] }
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: bridgeId(5),
        method: 'native.store.rows',
        params: storeRead
      })
    )
    bridge.client.pushState('connected')
    await flushBridge()

    expect(bridge.client.requests.map((request) => request.method)).toEqual(['status.get'])
    expect(bridge.client.streams).toEqual([])
    expect(bridge.nativeCalls).toEqual([{ verb: 'native.store.rows', params: storeRead }])
    expect(bridge.frames().findLast((frame) => frame.type === 'state')).toMatchObject({
      connection: { state: 'handshaking' }
    })
  })

  it("serves the phone's own store before the verdict, so drafts typed offline are saved", async () => {
    const { bridge } = heldBridge()
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: bridgeId(1),
        method: 'native.store.rows',
        params: { action: 'read', table: 'draft', keys: ['draft:chat:wt:'] }
      })
    )
    await flushBridge()

    expect(bridge.nativeCalls.map((call) => call.verb)).toEqual(['native.store.rows'])
  })

  it('re-sends init as connected once the verdict opens, then sends what waited', () => {
    const { bridge, verdict } = heldBridge()
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(1), method: 'worktree.ps', params: {} })
    )
    bridge.host.receive(subscribeFrame(bridgeId(2)))
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(3), method: 'stats.summary', params: {} })
    )
    bridge.host.receive(clientFrame({ type: 'cancel', id: bridgeId(3), target: 'request' }))

    verdict.status = PROVEN
    bridge.host.publishHostStatus()

    expect(
      bridge.frames().find((frame) => frame.type === 'init' && frame.hostStatus)
    ).toMatchObject({ connection: { state: 'connected' }, hostStatus: PROVEN })
    expect(bridge.client.requests.map((request) => request.method)).toEqual(['worktree.ps'])
    expect(bridge.client.streams.map((stream) => stream.method)).toEqual(['terminal.subscribe'])
  })

  it('keeps page order for a frame that lands after the status opens but before the flush', () => {
    const { bridge, verdict } = heldBridge()
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(1), method: 'worktree.ps', params: {} })
    )
    verdict.status = PROVEN
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(2), method: 'stats.summary', params: {} })
    )
    expect(bridge.client.requests).toEqual([])
    bridge.host.publishHostStatus()
    expect(bridge.client.requests.map((request) => request.method)).toEqual([
      'worktree.ps',
      'stats.summary'
    ])
  })
  it('re-sends a stream the page held across a reconnect only after the new verdict, before what waited', () => {
    const verdict: { status: HostStatusReply | null } = { status: PROVEN }
    const bridge = harness({ ready: true, readHostStatus: () => verdict.status })
    bridge.host.receive(subscribeFrame(bridgeId(1)))
    const stream = bridge.client.streams[0]!
    expect(stream.holdReplay?.(() => undefined)).toBe(false)

    verdict.status = null
    const resent: number[] = []
    expect(stream.holdReplay?.(() => resent.push(bridge.client.requests.length))).toBe(true)
    bridge.host.receive(
      clientFrame({ type: 'request', id: bridgeId(2), method: 'worktree.ps', params: {} })
    )
    bridge.host.publishHostStatus()
    expect(resent).toEqual([])

    verdict.status = PROVEN
    bridge.host.publishHostStatus()
    expect(resent).toEqual([0])
    expect(bridge.client.requests.map((request) => request.method)).toEqual(['worktree.ps'])
  })
})
