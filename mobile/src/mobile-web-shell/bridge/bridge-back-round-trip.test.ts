import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { BRIDGE_BACK_CLAIM_NOTIFY, BRIDGE_BACK_FRAME } from './bridge-page-back'
import { createFakeBridgePortPair, type BridgePortPair } from './bridge-port-pair-test-harness'
import type { FakeRpcClient } from '../bridge-host-test-fakes'

async function opened(): Promise<BridgePortPair<FakeRpcClient>> {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  return pair
}

/** Every notify the page posted, by name, so a case can say what crossed and what did not. */
function notifies(pair: BridgePortPair<FakeRpcClient>): string[] {
  return pair
    .readToShell()
    .filter((frame) => frame.type === 'notify')
    .map((frame) => frame.name)
}

/**
 * The whole lane, end to end: the page claims the key, the shell hands one press over, the page
 * spends it. Run over the pair rather than over either half, because the claim and the press are
 * two frames in opposite directions and each side only ever sees one of them.
 */
describe('a Back press crossing from the shell to the page', () => {
  it('reaches the consumer the page claimed with', async () => {
    const pair = await opened()
    const took = vi.fn(() => true)
    pair.client.claimBack(took)
    await pair.flush()
    expect(pair.backClaims).toEqual([true])
    expect(pair.host.sendBack()).toBe(true)
    await pair.flush()
    expect(took).toHaveBeenCalledTimes(1)
    // Nothing crosses back for a press that landed: the page spent it.
    expect(notifies(pair)).toEqual([BRIDGE_BACK_CLAIM_NOTIFY])
  })

  it('tells the shell when the last consumer lets go, so the key goes back to the navigator', async () => {
    const pair = await opened()
    const release = pair.client.claimBack(() => true)
    await pair.flush()
    release()
    await pair.flush()
    expect(pair.backClaims).toEqual([true, false])
  })

  /**
   * The claim and the press cross on separate frames, so a sheet that closed between the two leaves
   * the shell holding one this page cannot spend. The press is handed back rather than dropped: a
   * key that does nothing is the failure the lane exists to remove.
   */
  it('hands a press nothing took back as a navigate-back, and says so on the page', async () => {
    const pair = await opened()
    const release = pair.client.claimBack(() => true)
    await pair.flush()
    release()
    await pair.flush()
    // The shell still sends one, standing in for a claim that went stale in flight.
    pair.host.receive(
      JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready', accepts: [BRIDGE_BACK_FRAME] })
    )
    await pair.flush()
    expect(pair.host.sendBack()).toBe(true)
    await pair.flush()
    expect(pair.backPops).toEqual(['popped'])
    expect(pair.diagnostics).toContainEqual({ kind: 'back-unclaimed' })
  })

  /**
   * The shell forgets on purpose — `readReady` drops the claim and a rebuilt host starts with
   * none — so a claim the page took before that shell existed is one nothing over there knows
   * about. `init` is the shell saying it is here now, and the page answers it with the state.
   *
   * Without this the page keeps a sheet open, the shell believes nothing is claimed, and the next
   * press pops the screen out from under it.
   */
  it('says the claim again on the init that answers a re-asked ready', async () => {
    const pair = await opened()
    pair.client.claimBack(() => true)
    await pair.flush()
    expect(pair.backClaims).toEqual([true])
    // The page re-asks, which is what a stale `state` frame makes it do; the host drops the claim
    // answering it, and the page's re-assert is what puts the two back in step.
    pair.host.receive(
      JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready', accepts: [BRIDGE_BACK_FRAME] })
    )
    await pair.flush()
    expect(pair.backClaims).toEqual([true, false, true])
  })

  it('says nothing again when this document is holding nothing', async () => {
    const pair = await opened()
    pair.host.receive(
      JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready', accepts: [BRIDGE_BACK_FRAME] })
    )
    await pair.flush()
    expect(notifies(pair)).toEqual([])
    expect(pair.backClaims).toEqual([])
  })

  it('gives the key back when the page client closes', async () => {
    const pair = await opened()
    pair.client.claimBack(() => true)
    await pair.flush()
    pair.client.close()
    await pair.flush()
    // The page's own `close` is what the host reads; the claim dies with the document either way.
    expect(pair.backClaims).toEqual([true, false])
  })
})

/**
 * Both halves of the mixed-version matrix. The page bundle is served by a desktop that updates
 * independently of the installed shell, so one side older than the other is the normal state and
 * each direction has to degrade to exactly what Back did before this lane: the navigator pops.
 */
describe('a shell and a page built either side of the Back lane', () => {
  it('old shell, new page: the page never posts a claim it was not offered', async () => {
    // The `init.accepts` this shell sends, with the claim taken back out of it on the wire — which
    // is exactly the frame a shell built before the name would have posted.
    const pair = createFakeBridgePortPair({
      rewriteToPage: (json) => {
        const frame: Record<string, unknown> = JSON.parse(json)
        const accepts = frame.accepts
        if (frame.type !== 'init' || !Array.isArray(accepts)) {
          return json
        }
        return JSON.stringify({
          ...frame,
          accepts: accepts.filter((name) => name !== BRIDGE_BACK_CLAIM_NOTIFY)
        })
      }
    })
    await pair.flush()
    pair.client.claimBack(() => true)
    await pair.flush()
    expect(notifies(pair)).toEqual([])
    expect(pair.backClaims).toEqual([])
    // And the re-assert is held to the same declaration: a second `init` from a shell that never
    // named the claim is still one the page says nothing back to.
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
    await pair.flush()
    expect(notifies(pair)).toEqual([])
  })

  it('new shell, old page: the shell never sends a press the page would refuse', async () => {
    const pair = await opened()
    // The same document reloaded as a build that declares nothing, which is what a released page is.
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
    await pair.flush()
    const before = pair.toPage.length
    expect(pair.host.sendBack()).toBe(false)
    await pair.flush()
    expect(pair.toPage).toHaveLength(before)
  })

  /** Why that gate has to exist: an older page's reader takes the whole frame down rather than
   *  ignoring a type it has never heard of. */
  it('a page too old to read the frame refuses it whole', async () => {
    const pair = createFakeBridgePortPair({
      rewriteToPage: (json) =>
        JSON.parse(json).type === BRIDGE_BACK_FRAME ? '{"v":1,"type":"b4ck"}' : json
    })
    await pair.flush()
    pair.host.receive(
      JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready', accepts: [BRIDGE_BACK_FRAME] })
    )
    await pair.flush()
    expect(pair.host.sendBack()).toBe(true)
    await pair.flush()
    expect(pair.diagnostics).toContainEqual({ kind: 'refused', refusal: 'unrecognised-message' })
    expect(pair.backPops).toEqual([])
  })
})
