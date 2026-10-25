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
 * The unit the frame cap is counted in, which is UTF-8 bytes on every side of this bridge.
 *
 * Read off both shells rather than assumed: iOS gates the inbound frame on `json.utf8.count`
 * (`MobileWebShellView.swift`, through `MobileWebShellBridge.acceptsByteCount`), Android on
 * `json.toByteArray(Charsets.UTF_8).size` (`MobileWebShellView.kt`, through
 * `acceptsMobileWebShellBridgeByteCount`), and both caps are `640 * 1024`.
 *
 * A JavaScript string is counted in UTF-16 code units, and the two are only equal for ASCII. A
 * sender measuring `json.length` accepts a frame of 250,000 CJK characters — a quarter of the cap
 * in units, and over the cap in bytes — which the shell then drops without answering, leaving the
 * caller pending for the life of the page. The refusal exists to end exactly that.
 *
 * `raw.length > cap` inside the reader is not that mistake. It is a cheap first refusal in the safe
 * direction: every code unit encodes to at least one byte, so a string over the cap in units is over
 * it in bytes too, and the byte count decides everything it does not catch.
 */

/** Three bytes in UTF-8, one code unit in UTF-16, and not escaped by `JSON.stringify`. */
const WIDE_CHARACTER = '漢'
/** Comfortably under the cap in code units and comfortably over it in bytes. */
const WIDE_CHARACTER_COUNT = 250_000

describe('what the frame cap counts', () => {
  it('refuses a frame under the cap in code units and over it in bytes', async () => {
    const pad = WIDE_CHARACTER.repeat(WIDE_CHARACTER_COUNT)
    // The precondition, without which this is just another oversized frame: a sender reading
    // `json.length` sees room to spare here and posts it.
    expect(pad.length).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(new TextEncoder().encode(pad).byteLength).toBeGreaterThan(BRIDGE_MAX_MESSAGE_BYTES)

    const pair = createFakeBridgePortPair()
    await pair.flush()
    const before = pair.toShell.length
    let rejection: string | null = null
    void pair.client.sendRequest('git.diff', { pad }).catch((error: Error) => {
      rejection = error.name
    })
    await pair.flush()

    expect(rejection).toBe('BridgeRequestOversizedError')
    expect(pair.toShell.slice(before)).toEqual([])
    // And the reader agrees, so this is the shells' rule and not a stricter one the page invented.
    const frame = JSON.stringify({
      v: 1,
      type: 'request',
      id: '0'.repeat(22),
      method: 'git.diff',
      params: { pad }
    })
    expect(frame.length).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(pair.diagnostics).toEqual([
      { kind: 'send-oversized', bytes: new TextEncoder().encode(frame).byteLength }
    ])
    const read = parseBridgeMessage(frame, 'page-to-shell')
    expect(read.ok ? null : read.refusal).toBe('oversized')
  })
})

afterEach(closeResources)
