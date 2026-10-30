import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES, parseBridgeMessage } from './bridge-caps'
import { createFakeBridgePortPair as createPair } from './bridge-port-pair-test-harness'

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

// Compare sender/reader at cap and cap+1 to catch off-by-one hangs; also require the shared predicate so a copied bound cannot drift later.

// Measure serialized request overhead rather than counting envelope characters by hand.
const envelope = (params: unknown) =>
  JSON.stringify({ v: 1, type: 'request', id: '0'.repeat(22), method: METHOD, params })
const METHOD = 'git.status'

function framePayload(bytes: number): { pad: string } {
  const pad = bytes - new TextEncoder().encode(envelope({ pad: '' })).byteLength
  if (pad < 1) {
    throw new Error(`a ${bytes}-byte frame cannot hold this envelope`)
  }
  return { pad: 'x'.repeat(pad) }
}

async function sendOfSize(bytes: number) {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  const before = pair.toShell.length
  let rejection: string | null = null
  void pair.client.sendRequest(METHOD, framePayload(bytes)).catch((error: Error) => {
    rejection = error.name
  })
  await pair.flush()
  const posted = pair.toShell.slice(before).filter((raw) => raw.includes(`"method":"${METHOD}"`))
  return {
    rejection,
    posted,
    expected: envelope(framePayload(bytes)),
    diagnostics: pair.diagnostics.map((entry) => entry.kind)
  }
}

describe('the page frame cap at its boundary', () => {
  it('sends a frame of exactly the cap, which the reader accepts', async () => {
    const sent = await sendOfSize(BRIDGE_MAX_MESSAGE_BYTES)
    expect(sent.rejection).toBeNull()
    expect(sent.posted).toHaveLength(1)
    expect(new TextEncoder().encode(sent.posted[0]).byteLength).toBe(BRIDGE_MAX_MESSAGE_BYTES)
    expect(parseBridgeMessage(sent.posted[0], 'page-to-shell').ok).toBe(true)
    expect(sent.diagnostics).toEqual([])
  })

  it('refuses a frame one byte over it, which the reader would have dropped', async () => {
    const overCap = BRIDGE_MAX_MESSAGE_BYTES + 1
    const sent = await sendOfSize(overCap)
    expect(sent.rejection).toBe('BridgeRequestOversizedError')
    expect(sent.posted).toEqual([])
    expect(sent.diagnostics).toEqual(['send-oversized'])
    expect(new TextEncoder().encode(sent.expected).byteLength).toBe(overCap)
    const read = parseBridgeMessage(sent.expected, 'page-to-shell')
    expect(read.ok).toBe(false)
    expect(read.ok ? null : read.refusal).toBe('oversized')
  })
})

afterEach(closeResources)
