import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '../protocol/bridge-frame-fields'

import { createFakeBridgePortPair as createPair } from '../test-support/bridge-port-pair-test-harness'
import type { BridgePortPair } from '../test-support/bridge-port-pair-contract'
import type { FakeRpcClient } from '../../test-support/bridge-host-test-fakes'

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

// Use both bridge endpoints: the page’s claim and shell’s Back press travel in opposite directions, so testing either alone misses their coordination.
describe('a Back press crossing from the shell to the page', () => {
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

  it('gives the key back when the page client closes', async () => {
    const pair = await opened()
    pair.client.claimBack(() => true)
    await pair.flush()
    pair.client.close()
    await pair.flush()
    expect(pair.backClaims).toEqual([true, false])
  })
})

afterEach(closeResources)
