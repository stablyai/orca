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

/**
 * The page refuses exactly what the shell's reader refuses, at the boundary and by construction.
 *
 * The page holds its own copy of the reader's cap so a caller hears `oversized` rather than waiting
 * for a reply the shell will never send. That only works while the two agree to the byte: a sender
 * one unit more generous posts a frame the reader drops, and the hang the refusal exists to end
 * comes back for frames in that one-unit band.
 *
 * Two rules, because either alone passes against the defect. The boundary cases say the sender and
 * the reader answer the same way at `cap` and at `cap + 1`, which reds on an off-by-one. The census
 * says the client reaches the cap through the shared predicate and names no second spelling of it,
 * which reds on a copy that happens to be correct today.
 */

/**
 * The bytes a request frame carries besides its payload, measured rather than counted off the
 * envelope: `{"v":1,"type":"request","id":"<22>","method":"git.status","params":{"pad":""}}`.
 */
const envelope = (params: unknown) =>
  JSON.stringify({ v: 1, type: 'request', id: '0'.repeat(22), method: METHOD, params })
const METHOD = 'git.status'

/** A frame whose serialized length is exactly `bytes`, built from the measured overhead. */
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
    // The other half of "the same answer": the reader this sender is modelling takes it too, so
    // the page is not refusing frames the shell would have carried.
    expect(parseBridgeMessage(sent.posted[0], 'page-to-shell').ok).toBe(true)
    expect(sent.diagnostics).toEqual([])
  })

  it('refuses a frame one byte over it, which the reader would have dropped', async () => {
    const overCap = BRIDGE_MAX_MESSAGE_BYTES + 1
    const sent = await sendOfSize(overCap)
    expect(sent.rejection).toBe('BridgeRequestOversizedError')
    // Nothing was posted, which is the point: the shell never sees a frame it would answer nothing
    // to. A sender one unit more generous posts this and the caller waits for the life of the page.
    expect(sent.posted).toEqual([])
    expect(sent.diagnostics).toEqual(['send-oversized'])
    // And the reader agrees about this exact string, so the two are not merely both refusing
    // something — they refuse the same thing at the same point.
    expect(new TextEncoder().encode(sent.expected).byteLength).toBe(overCap)
    const read = parseBridgeMessage(sent.expected, 'page-to-shell')
    expect(read.ok).toBe(false)
    expect(read.ok ? null : read.refusal).toBe('oversized')
  })
})

afterEach(closeResources)
