import { describe, expect, it, vi } from 'vitest'
import type { AXNode } from '../browser/snapshot-ax-tree-walk'
import { VoiceScreenDriver, type VoiceCdpDebugger } from './voice-control-screen-driver'

type CdpCall = { method: string; params?: Record<string, unknown> }

function axNode(
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId: number,
  childIds?: string[]
): AXNode {
  return {
    nodeId,
    role: { type: 'role', value: role },
    name: { type: 'string', value: name },
    backendDOMNodeId,
    ...(childIds ? { childIds } : {})
  }
}

const AX_TREE: AXNode[] = [
  axNode('1', 'RootWebArea', 'Orca', 100, ['2', '3']),
  axNode('2', 'button', 'Assigned to me', 101),
  axNode('3', 'staticText', '#4882 Asana plugin: Authorize button silently no-ops', 102)
]

type FakeOptions = {
  xtermNodeIds?: number[]
  describeNodeThrowsFor?: Set<number>
  typeGuardResult?: string
  attached?: boolean
  terminalText?: string
}

function fakeDebugger(options: FakeOptions = {}) {
  const calls: CdpCall[] = []
  const dbg: VoiceCdpDebugger = {
    isAttached: () => options.attached ?? false,
    attach: vi.fn(),
    on: vi.fn(),
    sendCommand: (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      switch (method) {
        case 'Accessibility.enable':
          return Promise.resolve({})
        case 'Accessibility.getFullAXTree':
          return Promise.resolve({ nodes: AX_TREE })
        case 'DOM.getDocument':
          return Promise.resolve({ root: { nodeId: 1 } })
        case 'DOM.querySelectorAll':
          return Promise.resolve({ nodeIds: options.xtermNodeIds ?? [] })
        case 'DOM.describeNode': {
          const backendNodeId =
            typeof params?.backendNodeId === 'number' ? params.backendNodeId : -1
          if (options.describeNodeThrowsFor?.has(backendNodeId)) {
            return Promise.reject(new Error('No node with given backend id'))
          }
          // The xterm lookup path passes nodeId instead of backendNodeId.
          if (typeof params?.nodeId === 'number') {
            return Promise.resolve({ node: { backendNodeId: 200 } })
          }
          return Promise.resolve({ node: { backendNodeId } })
        }
        // DOM.requestNode deliberately unstubbed: it takes a Runtime objectId, not a
        // backendNodeId (protocol-proven — the two-hop form dies with "Invalid
        // parameters" on every click), so a regression hits the default rejection.
        case 'DOM.resolveNode':
          return Promise.resolve({ object: { objectId: 'obj-1' } })
        case 'Runtime.callFunctionOn':
          return Promise.resolve({ result: { value: options.typeGuardResult ?? 'ok' } })
        case 'Runtime.evaluate':
          return Promise.resolve({
            result: { value: options.terminalText ?? '$ npm test\n  42 passing\n' }
          })
        case 'DOM.getBoxModel':
          return Promise.resolve({ model: { content: [10, 10, 110, 10, 110, 30, 10, 30] } })
        case 'Input.dispatchMouseEvent':
        case 'Input.insertText':
          return Promise.resolve({})
        default:
          return Promise.reject(new Error(`unexpected CDP method ${method}`))
      }
    }
  }
  return { dbg, calls }
}

function driverWith(options: FakeOptions = {}) {
  const { dbg, calls } = fakeDebugger(options)
  const driver = new VoiceScreenDriver({ getDebugger: () => dbg, settleMs: 0 })
  return { driver, dbg, calls }
}

describe('VoiceScreenDriver', () => {
  it('see_screen returns the AX tree with refs and text rows', async () => {
    const { driver } = driverWith()
    const tree = await driver.seeScreen()
    expect(tree).toContain('[@e1] button "Assigned to me"')
    expect(tree).toContain('#4882 Asana plugin')
  })

  it('returns null when there is no owner window, and refuses actions honestly', async () => {
    const driver = new VoiceScreenDriver({ getDebugger: () => null, settleMs: 0 })
    expect(await driver.seeScreen()).toBeNull()
    const click = await driver.clickElement('@e1')
    expect(click).toEqual({ ok: false, error: 'The screen is not available right now.' })
  })

  it("never steals a debugger session the user's DevTools holds", async () => {
    const { driver, dbg } = driverWith({ attached: true })
    expect(await driver.seeScreen()).toBeNull()
    expect(dbg.attach).not.toHaveBeenCalled()
  })

  it('excludes xterm panes from the tree and says so', async () => {
    const withTerminal: AXNode[] = [
      ...AX_TREE,
      axNode('9', 'staticText', 'secret shell scrollback', 200)
    ]
    const { dbg, calls } = fakeDebugger({ xtermNodeIds: [55] })
    const original = dbg.sendCommand
    dbg.sendCommand = (method, params) =>
      method === 'Accessibility.getFullAXTree'
        ? Promise.resolve({ nodes: withTerminal })
        : original(method, params)
    const driver = new VoiceScreenDriver({ getDebugger: () => dbg, settleMs: 0 })
    const tree = await driver.seeScreen()
    expect(tree).not.toContain('secret shell scrollback')
    expect(tree).toContain('read_terminal shows their visible text')
    expect(
      calls.some((c) => c.method === 'DOM.querySelectorAll' && c.params?.selector === '.xterm')
    ).toBe(true)
  })

  it('click_element scrolls, then presses and releases at the element center', async () => {
    const { driver, calls } = driverWith()
    await driver.seeScreen()
    const result = await driver.clickElement('@e1')
    expect(result).toMatchObject({ ok: true, elementName: 'Assigned to me' })
    const mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent')
    expect(mouse.map((c) => c.params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased'
    ])
    expect(mouse[1]?.params).toMatchObject({ x: 60, y: 20, button: 'left', clickCount: 1 })
    // The result carries a fresh tree so the model never reuses stale refs.
    expect(result?.ok && result.tree).toContain('Assigned to me')
  })

  it('rejects unknown and stale refs with a see_screen nudge', async () => {
    const { driver } = driverWith()
    const unknown = await driver.clickElement('@e9')
    expect(unknown).toMatchObject({ ok: false })
    expect(unknown?.ok === false && unknown.error).toContain('see_screen')

    const stale = driverWith({ describeNodeThrowsFor: new Set([101]) })
    await stale.driver.seeScreen()
    const result = await stale.driver.clickElement('@e1')
    expect(result?.ok === false && result.error).toContain('screen changed')
  })

  // Live failure this guards: the tree prints [@e36] but the model transcribed "e36",
  // got "Unknown ref", re-ran see_screen, sent "e36" again, and gave up blaming a
  // "changing screen". The sigil is typography, not identity — tolerate its loss.
  it('accepts a ref missing the @ sigil', async () => {
    const { driver, calls } = driverWith()
    await driver.seeScreen()
    const result = await driver.clickElement('e1')
    expect(result).toMatchObject({ ok: true, elementName: 'Assigned to me' })
    expect(calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(true)
  })

  it('an unknown ref after a snapshot names the snapshot, not a missing see_screen', async () => {
    const { driver } = driverWith()
    await driver.seeScreen()
    const result = await driver.clickElement('@e99')
    expect(result?.ok === false && result.error).toContain('the latest see_screen holds')
    // And with no snapshot at all, the message says THAT instead of implying one exists.
    const fresh = driverWith()
    const never = await fresh.driver.clickElement('@e1')
    expect(never?.ok === false && never.error).toContain('No see_screen snapshot exists yet')
  })

  it('resolves the node in one hop — resolveNode by backendNodeId, never requestNode', async () => {
    // CDP-probed: DOM.requestNode takes a Runtime objectId, so the old two-hop form
    // failed with "Invalid parameters" on every click. The one-hop resolveNode shape is
    // the contract this test pins.
    const { driver, calls } = driverWith()
    await driver.seeScreen()
    await driver.clickElement('@e1')
    expect(calls.some((c) => c.method === 'DOM.requestNode')).toBe(false)
    const resolve = calls.find((c) => c.method === 'DOM.resolveNode')
    expect(resolve?.params).toEqual({ backendNodeId: 101 })
  })

  it('type_into focuses the field and inserts the text through the IME path', async () => {
    const { driver, calls } = driverWith()
    await driver.seeScreen()
    const result = await driver.typeInto('@e1', 'hello world')
    expect(result).toMatchObject({ ok: true, elementName: 'Assigned to me' })
    const insert = calls.find((c) => c.method === 'Input.insertText')
    expect(insert?.params).toEqual({ text: 'hello world' })
  })

  it('type_into refuses terminal panes and points at run_command', async () => {
    const { driver, calls } = driverWith({ typeGuardResult: 'terminal' })
    await driver.seeScreen()
    const result = await driver.typeInto('@e1', 'rm -rf /')
    expect(result?.ok === false && result.error).toContain('run_command')
    expect(calls.some((c) => c.method === 'Input.insertText')).toBe(false)
  })

  it('type_into refuses non-field elements', async () => {
    const { driver } = driverWith({ typeGuardResult: 'not-a-field' })
    await driver.seeScreen()
    const result = await driver.typeInto('@e1', 'x')
    expect(result?.ok === false && result.error).toContain('not a text field')
  })

  it('read_terminal returns the visible pane text via Runtime.evaluate', async () => {
    const { driver, calls } = driverWith({ terminalText: '$ gh run watch\n  ✓ tests passed\n' })
    const text = await driver.readTerminalText()
    expect(text).toContain('tests passed')
    const evaluate = calls.find((c) => c.method === 'Runtime.evaluate')
    expect(evaluate?.params?.expression).toContain('.xterm-rows')
  })

  it('read_terminal returns null with no owner window', async () => {
    const driver = new VoiceScreenDriver({ getDebugger: () => null, settleMs: 0 })
    expect(await driver.readTerminalText()).toBeNull()
  })
})
