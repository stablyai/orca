import { describe, expect, it } from 'vitest'
import { clientFrame } from '../test-support/bridge-host-test-fakes'
import { harness } from '../test-support/bridge-host-test-harness'
import { BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY } from '../bridge/native-capabilities/bridge-terminal-key'

function claim(claimed: boolean, inputOwner?: string): string {
  return clientFrame({
    type: 'notify',
    name: BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY,
    claimed,
    inputOwner
  })
}

describe('a terminal key rail claim across host rebuilds', () => {
  it('does not carry a rail the page has explicitly released', () => {
    const first = harness({ ready: true })
    first.host.receive(claim(true, 'pane-a'))
    first.host.receive(claim(false))
    const snapshot = first.host.readSessionBack()
    expect(snapshot).not.toHaveProperty('terminalKeyRailClaim')
    const rebuilt = harness({ sessionEstablished: true, sessionBack: snapshot })
    expect(rebuilt.host.sendTerminalKey('enter', 'pane-a')).toBe(false)
  })
})
