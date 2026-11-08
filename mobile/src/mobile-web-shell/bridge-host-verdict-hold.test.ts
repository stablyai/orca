import { describe, expect, it } from 'vitest'
import type { HostStatusReply } from '../transport/host-status-reply-schema'
import { bridgeId, clientFrame } from './bridge-host-test-fakes'
import { harness, subscribeFrame } from './bridge-host-test-harness'

const PROVEN: HostStatusReply = { protocolVersion: 10, minCompatibleMobileVersion: 1 }

// A cached page renders before this connection's verdict; nothing it sends may reach the desktop until then.
describe('the connection verdict hold', () => {
  function heldBridge() {
    const verdict: { status: HostStatusReply | null } = { status: null }
    const bridge = harness({ ready: true, readHostStatus: () => verdict.status })
    return { bridge, verdict }
  }

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
