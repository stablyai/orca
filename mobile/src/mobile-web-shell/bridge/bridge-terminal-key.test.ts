import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_SHELL_GRANTS } from '../page-route-policy'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import {
  BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY,
  BRIDGE_TERMINAL_KEY_RAIL_GRANT,
  type BridgeTerminalKeyId
} from './bridge-terminal-key'

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

it('carries toolbar state across both bridge ends and delivers toolbar actions only to the current owner', async () => {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  const pressed: string[] = []
  const toolbar = {
    canSend: true,
    canCompose: true,
    keyboardVisible: false,
    liveInputEnabled: true,
    phoneDisplayMode: false,
    runsAgent: false,
    modifiers: { ctrl: 'once', alt: 'off', shift: 'locked' } as const
  }
  const release = pair.client.claimTerminalKeyRail(
    (key) => pressed.push(key),
    'toolbar-owner',
    toolbar
  )
  await pair.flush()
  expect(
    pair.toShell
      .map((json) => JSON.parse(json))
      .findLast((frame) => frame.name === BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY)?.toolbar
  ).toEqual(toolbar)
  expect(pair.host.sendTerminalKey('toggleKeyboard', 'toolbar-owner')).toBe(true)
  expect(pair.host.sendTerminalKey('moreKeys', 'toolbar-owner')).toBe(true)
  await pair.flush()
  expect(pressed).toEqual(['toggleKeyboard', 'moreKeys'])
  const updateStart = pair.toShell.length
  release.update('toolbar-owner', { ...toolbar, keyboardVisible: true })
  await pair.flush()
  expect(
    pair.toShell
      .slice(updateStart)
      .map((json) => JSON.parse(json))
      .filter((frame) => frame.name === BRIDGE_TERMINAL_KEY_RAIL_CLAIM_NOTIFY)
  ).toEqual([
    expect.objectContaining({
      claimed: true,
      inputOwner: 'toolbar-owner',
      toolbar: { ...toolbar, keyboardVisible: true }
    })
  ])
  release()
  await pair.flush()
  expect(pair.host.sendTerminalKey('toggleKeyboard', 'toolbar-owner')).toBe(false)
  const releaseEnd = pair.toShell.length
  release.update('toolbar-owner', toolbar)
  await pair.flush()
  expect(pair.toShell).toHaveLength(releaseEnd)
})
