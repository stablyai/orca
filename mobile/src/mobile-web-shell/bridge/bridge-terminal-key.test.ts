import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_SHELL_GRANTS } from '../page-route-policy'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import {
  BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY,
  BRIDGE_TERMINAL_KEY_RAIL_GRANT,
  type BridgeTerminalKeyId,
  type BridgeTerminalKeyRail
} from './bridge-terminal-key'

describe('the iPhone Duo key rail over the bridge', () => {
  it('tells the page which keys the rail holds, and moves that live as the window turns', async () => {
    const pair = createFakeBridgePortPair({ terminalKeyRail: ['escape', 'tab', 'enter'] })
    await pair.flush()
    expect(pair.client.getShellSession()?.terminalKeyRail).toEqual(['escape', 'tab', 'enter'])
    const seen: BridgeTerminalKeyRail[] = []
    pair.client.onTerminalKeyRailUpdate((keys) => seen.push(keys))

    pair.host.publishTerminalKeyRail(['escape'])
    await pair.flush()
    pair.host.publishTerminalKeyRail(['escape'])
    await pair.flush()
    pair.host.publishTerminalKeyRail([])
    await pair.flush()
    expect(pair.client.getShellSession()?.terminalKeyRail).toEqual([])
    expect(seen).toEqual([['escape'], []])
  })

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

  it('sends nothing either way with a shell that did not grant it, which is every older one', async () => {
    const pair = createFakeBridgePortPair({
      routeGrants: MOBILE_WEB_SHELL_GRANTS.filter(
        (grant) => grant !== BRIDGE_TERMINAL_KEY_RAIL_GRANT
      )
    })
    await pair.flush()
    const release = pair.client.claimTerminalKeyRail(() => {})
    await pair.flush()
    release()
    await pair.flush()
    expect(pair.toShell.some((json) => json.includes(BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY))).toBe(
      false
    )

    const before = pair.readToPage().length
    expect(pair.host.sendTerminalKey('enter')).toBe(false)
    await pair.flush()
    expect(pair.readToPage()).toHaveLength(before)
  })
})
