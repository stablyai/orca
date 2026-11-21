import { describe, expect, it } from 'vitest'

import { createFakeBridgePortPair } from '../test-support/bridge-port-pair-test-harness'
import { BRIDGE_PROTOCOL_VERSION } from '../protocol/bridge-frame-fields'
import type { BridgeTerminalKeyId } from './bridge-terminal-key'

describe('the iPhone Duo key rail over the bridge', () => {
  it('hears the page claim the rail, and drops the claim when a document starts or ends', async () => {
    const pair = createFakeBridgePortPair({ terminalKeyRail: ['escape', 'arrowUp'] })
    await pair.flush()
    const pressed: BridgeTerminalKeyId[] = []
    const release = pair.client.claimTerminalKeyRail((key) => pressed.push(key))
    await pair.flush()
    expect(pair.terminalKeyRailClaims.at(-1)).toBe(true)

    expect(pair.host.sendTerminalKey('escape')).toBe(true)
    expect(pair.host.sendTerminalKey('arrowUp')).toBe(true)
    await pair.flush()
    expect(pressed).toEqual(['escape', 'arrowUp'])

    // A re-asked `ready` drops the claim, and the page still holding one claims again on its `init`.
    pair.host.receive(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }))
    await pair.flush()
    expect(pair.terminalKeyRailClaims.slice(-2)).toEqual([false, true])

    release()
    await pair.flush()
    expect(pair.terminalKeyRailClaims.at(-1)).toBe(false)
  })
  it('drops queued old-owner presses and rejects held repeats after focus moves', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const oldKeys: BridgeTerminalKeyId[] = []
    const newKeys: BridgeTerminalKeyId[] = []
    const release = pair.client.claimTerminalKeyRail((key) => oldKeys.push(key), 'pane-a-1')
    await pair.flush()
    expect(pair.host.sendTerminalKey('arrowUp', 'pane-a-1')).toBe(true)
    release()
    pair.client.claimTerminalKeyRail((key) => newKeys.push(key), 'pane-b-2')
    await pair.flush()
    expect(oldKeys).toEqual([])
    expect(newKeys).toEqual([])
    expect(pair.host.sendTerminalKey('arrowUp', 'pane-a-1')).toBe(false)
    expect(pair.host.sendTerminalKey('arrowUp', 'pane-b-2')).toBe(true)
    await pair.flush()
    expect(newKeys).toEqual(['arrowUp'])
  })
})
