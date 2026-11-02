import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge-page-back'
import {
  createFakeBridgePortPair as createPair,
  type BridgePortPair
} from './bridge-port-pair-test-harness'
import type { FakeRpcClient } from '../bridge-host-test-fakes'

const resources = new Set<ReturnType<typeof createPair>>()
function createFakeBridgePortPair(
  ...args: Parameters<typeof createPair>
): ReturnType<typeof createPair> {
  const resource = createPair(...args)
  resources.add(resource)
  return resource
}
function closeResources(): void {
  for (const resource of resources) {
    resource.client.close()
    resource.host.dispose()
  }
  resources.clear()
}

async function opened(): Promise<BridgePortPair<FakeRpcClient>> {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  return pair
}

function notifies(pair: BridgePortPair<FakeRpcClient>): string[] {
  return pair
    .readToShell()
    .filter((frame) => frame.type === 'notify')
    .map((frame) => frame.name)
}

// Use both bridge endpoints: the page’s claim and shell’s Back press travel in opposite directions, so testing either alone misses their coordination.
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
    expect(pair.readToShell().find((frame) => frame.type === 'ready')).toMatchObject({
      v: 1,
      type: 'ready'
    })
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

  // A sheet can close between claim and press; hand an unclaimed press back to native navigation instead of swallowing it.
  it('hands a press nothing took back as a navigate-back, and says so on the page', async () => {
    const pair = await opened()
    const release = pair.client.claimBack(() => true)
    await pair.flush()
    release()
    await pair.flush()
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
    await pair.flush()
    expect(pair.host.sendBack()).toBe(true)
    await pair.flush()
    expect(pair.backPops).toEqual(['popped'])
    expect(pair.diagnostics).toContainEqual({ kind: 'back-unclaimed' })
  })

  // Reassert the page’s current claim on init because readReady clears the shell’s claim; otherwise Back can pop a screen beneath an open sheet.
  it('says the claim again on the init that answers a re-asked ready', async () => {
    const pair = await opened()
    pair.client.claimBack(() => true)
    await pair.flush()
    expect(pair.backClaims).toEqual([true])
    // A stale state causes another ready/init; reassert the claim after the shell clears it.
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
    expect(pair.readToPage().at(-1)).toEqual({ v: 1, type: 'back' })
    expect(pair.backPops).toEqual(['popped'])
    expect(pair.diagnostics).toContainEqual({ kind: 'back-unclaimed' })
  })
})

afterEach(closeResources)
