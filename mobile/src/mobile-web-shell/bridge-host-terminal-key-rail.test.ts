import { describe, expect, it } from 'vitest'
import { clientFrame } from './bridge-host-test-fakes'
import { harness } from './bridge-host-test-harness'
import {
  BRIDGE_TERMINAL_KEY_FRAME,
  BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY
} from './bridge/bridge-terminal-key'

function claim(claimed: boolean, inputOwner?: string): string {
  return clientFrame({
    type: 'notify',
    name: BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY,
    claimed,
    inputOwner
  })
}

describe('a terminal key rail claim across host rebuilds', () => {
  it('delivers the first key for the established owner without another ready or storage refresh', () => {
    const first = harness({ ready: true })
    first.host.receive(claim(true, 'pane-a'))
    expect(first.host.sendTerminalKey('arrowUp', 'pane-a')).toBe(true)
    first.host.dispose()

    const rebuilt = harness({
      sessionEstablished: true,
      sessionBack: first.host.readSessionBack()
    })
    expect(rebuilt.host.sendTerminalKey('arrowUp', 'pane-a')).toBe(true)
    expect(rebuilt.last()).toEqual({
      v: 1,
      type: BRIDGE_TERMINAL_KEY_FRAME,
      key: 'arrowUp',
      inputOwner: 'pane-a'
    })
    expect(rebuilt.host.sendTerminalKey('arrowUp', 'pane-b')).toBe(false)
  })

  it.each(['ready', 'close'] as const)(
    'drops the carried claim on %s before a new owner takes it',
    (type) => {
      const first = harness({ ready: true })
      first.host.receive(claim(true, 'pane-a'))
      const rebuilt = harness({
        sessionEstablished: true,
        sessionBack: first.host.readSessionBack()
      })
      rebuilt.host.receive(clientFrame({ type }))
      expect(rebuilt.host.sendTerminalKey('arrowUp', 'pane-a')).toBe(false)
      expect(rebuilt.host.readSessionBack()).not.toHaveProperty('terminalKeyRailClaim')

      if (type === 'close') {
        rebuilt.host.receive(clientFrame({ type: 'ready' }))
      }
      rebuilt.host.receive(claim(true, 'pane-b'))
      expect(rebuilt.host.sendTerminalKey('enter', 'pane-a')).toBe(false)
      expect(rebuilt.host.sendTerminalKey('enter', 'pane-b')).toBe(true)
    }
  )

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
