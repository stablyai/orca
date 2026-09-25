import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRIDGE_MAX_MESSAGE_BYTES, parseBridgeMessage } from './bridge-caps'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'

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
const FRAME_OVERHEAD_BYTES = 96
const METHOD = 'git.status'

/** A frame whose serialized length is exactly `bytes`, built from the measured overhead. */
function framePayload(bytes: number): { pad: string } {
  const pad = bytes - FRAME_OVERHEAD_BYTES
  if (pad < 1) {
    throw new Error(`a ${bytes}-byte frame cannot hold this envelope`)
  }
  return { pad: 'x'.repeat(pad) }
}

/**
 * Sends one frame of the given size and reads what became of it.
 *
 * Not awaited to settlement: a frame that leaves stays pending, because the fake client answers
 * nothing. A macrotask is long enough for a refusal to reach its `catch` and short enough that a
 * frame which did leave is still unanswered, which is exactly the two outcomes being told apart.
 */
async function sendOfSize(bytes: number) {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  const before = pair.toShell.length
  let rejection: string | null = null
  void pair.client.sendRequest(METHOD, framePayload(bytes)).catch((error: Error) => {
    rejection = error.name
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const posted = pair.toShell.slice(before).filter((raw) => raw.includes(`"method":"${METHOD}"`))
  return { rejection, posted, diagnostics: pair.diagnostics.map((entry) => entry.kind) }
}

describe('the page frame cap at its boundary', () => {
  it('measures the envelope it builds its boundary frames from', () => {
    // The overhead above is a constant in a test, which rots the moment the envelope grows a field.
    // This is what says it is still right: a frame asked for at exactly the cap must serialize to
    // exactly the cap.
    const payload = framePayload(BRIDGE_MAX_MESSAGE_BYTES)
    const envelope = JSON.stringify({
      v: 1,
      type: 'request',
      id: '0'.repeat(22),
      method: METHOD,
      params: payload
    })
    expect(envelope.length).toBe(BRIDGE_MAX_MESSAGE_BYTES)
  })

  it('sends a frame of exactly the cap, which the reader accepts', async () => {
    const sent = await sendOfSize(BRIDGE_MAX_MESSAGE_BYTES)
    expect(sent.rejection).toBeNull()
    expect(sent.posted).toHaveLength(1)
    expect(sent.posted[0].length).toBe(BRIDGE_MAX_MESSAGE_BYTES)
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
    const read = parseBridgeMessage(JSON.stringify({ pad: 'x'.repeat(overCap) }), 'page-to-shell')
    expect(read.ok).toBe(false)
    expect(read.ok ? null : read.refusal).toBe('oversized')
  })

  it('reaches the cap through the shared predicate and spells it nowhere else', () => {
    // The census half. A copy of the bound inside the client is a second spelling that can only
    // drift from the one the reader applies, and it would pass every case above on the day it was
    // written. `isBridgeFrameWithinCap` is the one thing both sides call.
    const client = readFileSync(join(import.meta.dirname, 'bridge-rpc-client.ts'), 'utf8')
    expect(client).toContain('isBridgeFrameWithinCap(')
    expect(client).not.toContain('BRIDGE_MAX_MESSAGE_BYTES')
    // And the predicate is the reader's own, not a lookalike beside it: the module that parses
    // inbound frames is the module that exports it.
    const caps = readFileSync(join(import.meta.dirname, 'bridge-caps.ts'), 'utf8')
    expect(caps).toContain('export function isBridgeFrameWithinCap')
    expect(caps).toContain('if (!isBridgeFrameWithinCap(raw))')
  })
})
