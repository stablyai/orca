import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge-page-back'
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
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
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
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
    await pair.flush()
    expect(pair.backClaims).toEqual([true, false, true])
  })

  it('says nothing again when this document is holding nothing', async () => {
    const pair = await opened()
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
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

describe('the Back lane with no negotiation', () => {
  it('hands a press to any page it serves, whose ready declares nothing', async () => {
    const pair = await opened()
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
    await pair.flush()
    const before = pair.toPage.length
    expect(pair.host.sendBack()).toBe(true)
    await pair.flush()
    expect(pair.toPage.length).toBe(before + 1)
  })

  it('posts the claim to the shell with nothing offered in init', async () => {
    const pair = await opened()
    pair.client.claimBack(() => true)
    await pair.flush()
    expect(notifies(pair)).toEqual([BRIDGE_BACK_CLAIM_NOTIFY])
    expect(pair.backClaims).toEqual([true])
  })
})
