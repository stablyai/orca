import { describe, expect, it } from 'vitest'
import { clientFrame } from './bridge-host-test-fakes'
import { harness } from './bridge-host-test-harness'
import { BRIDGE_BACK_CLAIM_NOTIFY, BRIDGE_BACK_FRAME } from './bridge/bridge-page-back'

function ready(): string {
  return clientFrame({ type: 'ready' })
}

function claim(claimed: boolean): string {
  return clientFrame({ type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed })
}

// Clear Back claims on every document-ending path; a stale claim hands the key to an unrelated page and swallows navigation.
describe('the claim a host holds on the device Back key', () => {
  it('carries the page taking the key and letting it go, and says neither twice', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    bridge.host.receive(claim(true))
    bridge.host.receive(claim(true))
    bridge.host.receive(claim(false))
    expect(bridge.backClaims).toEqual([true, false])
  })

  it('drops it on the next document saying ready, which is the one that has to claim again', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    bridge.host.receive(claim(true))
    bridge.host.receive(ready())
    expect(bridge.backClaims).toEqual([true, false])
  })

  it('drops it when the page closes, which is the document saying it is going', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    bridge.host.receive(claim(true))
    bridge.host.receive(clientFrame({ type: 'close' }))
    expect(bridge.backClaims).toEqual([true, false])
  })

  // Host replacement preserves the live document and its Back claim; only leaving ready ends the session (shell-page-back-claim.ts).
  it('reports nothing when the host itself ends: the claim belongs to the session', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    bridge.host.receive(claim(true))
    bridge.host.dispose()
    expect(bridge.backClaims).toEqual([true])
    expect(bridge.host.readSessionBack()).toEqual({ claimed: true })
  })

  it('takes that seed without announcing a claim the screen never heard go', () => {
    const rebuilt = harness({
      sessionBack: { claimed: true },
      sessionEstablished: true
    })
    expect(rebuilt.backClaims).toEqual([])
    expect(rebuilt.host.sendBack()).toBe(true)
    expect(rebuilt.last()).toEqual({ v: 1, type: BRIDGE_BACK_FRAME })
  })

  it('lets the next document reset a carried claim, so the seed is not a latch', () => {
    const rebuilt = harness({
      sessionBack: { claimed: true },
      sessionEstablished: true
    })
    rebuilt.host.receive(ready())
    expect(rebuilt.backClaims).toEqual([false])
  })

  it('says nothing on a document that never claimed, so a drop is always a real one', () => {
    const bridge = harness()
    bridge.host.receive(ready())
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
  it('posts a back frame to the ready page', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    expect(bridge.host.sendBack()).toBe(true)
    expect(bridge.last()).toEqual({ v: 1, type: BRIDGE_BACK_FRAME })
  })

  // Older pages drop unknown Back frames; return false without sending so the navigator retains the press.
  it('sends nothing between documents, when the view belongs to no page', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    bridge.host.receive(clientFrame({ type: 'close' }))
    expect(bridge.host.sendBack()).toBe(false)
  })

  it('sends nothing once the host is disposed', () => {
    const bridge = harness()
    bridge.host.receive(ready())
    bridge.host.dispose()
    expect(bridge.host.sendBack()).toBe(false)
  })
})
