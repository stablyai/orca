import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRIDGE_MAX_MESSAGE_BYTES, parseBridgeMessage, utf8ByteLength } from './bridge-caps'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'

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
  it('is the unit both shells count, read from their own sources', () => {
    const shell = join(import.meta.dirname, '..', '..', '..', 'modules', 'orca-mobile-web-shell')
    const swift = readFileSync(join(shell, 'ios', 'MobileWebShellView.swift'), 'utf8')
    const kotlin = readFileSync(
      join(shell, 'android/src/main/java/expo/modules/orcamobilewebshell/MobileWebShellView.kt'),
      'utf8'
    )
    // The inbound gate on each platform, by the expression it measures with.
    expect(swift).toContain('bridgeGate.accepts(byteCount: json.utf8.count)')
    expect(kotlin).toContain('bridgeGate.accepts(json.toByteArray(Charsets.UTF_8).size)')
  })

  it('refuses a frame under the cap in code units and over it in bytes', async () => {
    const pad = WIDE_CHARACTER.repeat(WIDE_CHARACTER_COUNT)
    // The precondition, without which this is just another oversized frame: a sender reading
    // `json.length` sees room to spare here and posts it.
    expect(pad.length).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(utf8ByteLength(pad)).toBeGreaterThan(BRIDGE_MAX_MESSAGE_BYTES)

    const pair = createFakeBridgePortPair()
    await pair.flush()
    const before = pair.toShell.length
    let rejection: string | null = null
    void pair.client.sendRequest('git.diff', { pad }).catch((error: Error) => {
      rejection = error.name
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(rejection).toBe('BridgeRequestOversizedError')
    expect(pair.toShell.slice(before)).toEqual([])
    // And the reader agrees, so this is the shells' rule and not a stricter one the page invented.
    const frame = JSON.stringify({ v: 1, type: 'request', id: '0'.repeat(22), method: 'x', pad })
    const read = parseBridgeMessage(frame, 'page-to-shell')
    expect(read.ok ? null : read.refusal).toBe('oversized')
  })

  it('reports the byte count on the diagnostic, not the code-unit count', async () => {
    const pad = WIDE_CHARACTER.repeat(WIDE_CHARACTER_COUNT)
    const pair = createFakeBridgePortPair()
    await pair.flush()
    void pair.client.sendRequest('git.diff', { pad }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const [diagnostic] = pair.diagnostics
    expect(diagnostic?.kind).toBe('send-oversized')
    const reported = diagnostic?.kind === 'send-oversized' ? diagnostic.bytes : 0
    // Roughly three times the code-unit count, and over the cap. A field named `bytes` holding
    // units would read as a frame comfortably inside a cap it had just been refused by.
    expect(reported).toBeGreaterThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(reported).toBeGreaterThan(pad.length * 2)
  })
})
