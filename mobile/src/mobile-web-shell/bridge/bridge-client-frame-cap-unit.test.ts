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

// Both native shells enforce 640*1024 UTF-8 bytes (Swift utf8.count, Kotlin UTF_8 size); JS UTF-16 length alone admits oversized CJK requests that never receive replies.
// raw.length > cap is still a safe cheap rejection because each code unit costs at least one byte; byte length handles the remaining cases.

const WIDE_CHARACTER = '漢'
const WIDE_CHARACTER_COUNT = 250_000

describe('what the frame cap counts', () => {
  it('refuses a frame under the cap in code units and over it in bytes', async () => {
    const pad = WIDE_CHARACTER.repeat(WIDE_CHARACTER_COUNT)
    // Prove this fits by code units but not bytes, distinguishing the unit bug from ordinary oversize.
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
