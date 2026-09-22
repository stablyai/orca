import { describe, expect, it } from 'vitest'
import { clientFrame } from './bridge-host-test-fakes'
import { harness } from './bridge-host-test-harness'
import { BRIDGE_BACK_CLAIM_NOTIFY, BRIDGE_BACK_FRAME } from './bridge/bridge-page-back'

function ready(accepts?: readonly string[]): string {
  return clientFrame(accepts === undefined ? { type: 'ready' } : { type: 'ready', accepts })
}

function claim(claimed: boolean): string {
  return clientFrame({ type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed })
}

/**
 * The staleness half of the Back lane, which is the half with teeth.
 *
 * A claim the shell kept after its document went would have the key handed to a page that has
 * nothing to do with it, and a Back press that does nothing is worse than one that leaves the
 * screen. Every way a document ends is a case here.
 */
describe('the claim a host holds on the device Back key', () => {
  it('carries the page taking the key and letting it go, and says neither twice', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.receive(claim(true))
    bridge.host.receive(claim(true))
    bridge.host.receive(claim(false))
    expect(bridge.backClaims).toEqual([true, false])
  })

  it('drops it on the next document saying ready, which is the one that has to claim again', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.receive(claim(true))
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    expect(bridge.backClaims).toEqual([true, false])
  })

  it('drops it when the page closes, which is the document saying it is going', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.receive(claim(true))
    bridge.host.receive(clientFrame({ type: 'close' }))
    expect(bridge.backClaims).toEqual([true, false])
  })

  /**
   * A host ending is not a document ending. A client swapped under a live page rebuilds the host
   * while the WebView stays mounted, so a teardown that reported the claim gone would take the key
   * off an open sheet; what ends a session is the session leaving `ready`, which the screen's own
   * reader answers (`shell-page-back-claim.ts`) and `mobile-web-shell-back-claim-state.test.ts`
   * pins.
   */
  it('reports nothing when the host itself ends: the claim belongs to the session', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.receive(claim(true))
    bridge.host.dispose()
    expect(bridge.backClaims).toEqual([true])
  })

  it('hands what the session established to the host that takes over from it', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.receive(claim(true))
    bridge.host.dispose()
    expect(bridge.host.readSessionBack()).toEqual({ accepts: [BRIDGE_BACK_FRAME], claimed: true })
  })

  it('takes that seed without announcing a claim the screen never heard go', () => {
    const rebuilt = harness({
      sessionBack: { accepts: [BRIDGE_BACK_FRAME], claimed: true },
      sessionEstablished: true
    })
    expect(rebuilt.backClaims).toEqual([])
    // And it delivers on it: the page said it takes a press, over a session that is still open.
    expect(rebuilt.host.sendBack()).toBe(true)
    expect(rebuilt.last()).toEqual({ v: 1, type: BRIDGE_BACK_FRAME })
  })

  it('lets the next document reset a carried claim, so the seed is not a latch', () => {
    const rebuilt = harness({
      sessionBack: { accepts: [BRIDGE_BACK_FRAME], claimed: true },
      sessionEstablished: true
    })
    rebuilt.host.receive(ready([BRIDGE_BACK_FRAME]))
    expect(rebuilt.backClaims).toEqual([false])
  })

  it('says nothing on a document that never claimed, so a drop is always a real one', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.receive(clientFrame({ type: 'close' }))
    bridge.host.dispose()
    expect(bridge.backClaims).toEqual([])
  })

  it('refuses a claim from a page that has not asked for a session yet', () => {
    const bridge = harness()
    bridge.host.receive(claim(true))
    expect(bridge.backClaims).toEqual([])
    expect(bridge.diagnostics).toContainEqual({
      kind: 'notify-refused',
      name: BRIDGE_BACK_CLAIM_NOTIFY,
      why: 'before-ready'
    })
  })
})

describe('handing one press to the page', () => {
  it('posts a back frame to a page that said it takes one', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    expect(bridge.host.sendBack()).toBe(true)
    expect(bridge.last()).toEqual({ v: 1, type: BRIDGE_BACK_FRAME })
  })

  /**
   * Wire compatibility, the half a schema cannot state: a page built before the frame existed reads
   * one as `unrecognised-message` and drops the whole thing, so the shell must not send it. False
   * is what leaves the press to the navigator, which is what Back did before this lane.
   */
  it('sends nothing to a page that never declared it, and says so to the caller', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    const before = bridge.posted.length
    expect(bridge.host.sendBack()).toBe(false)
    expect(bridge.posted).toHaveLength(before)
  })

  it('sends nothing between documents, when the view belongs to no page', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.receive(clientFrame({ type: 'close' }))
    expect(bridge.host.sendBack()).toBe(false)
  })

  it('sends nothing once the host is disposed', () => {
    const bridge = harness()
    bridge.host.receive(ready([BRIDGE_BACK_FRAME]))
    bridge.host.dispose()
    expect(bridge.host.sendBack()).toBe(false)
  })
})
