import { describe, expect, it } from 'vitest'
import type { GlassesRawEvent, HudPageBuild } from '../glasses/glasses-bridge'
import { buildHudPage } from '../hud/hud-page-spec'
import { MockGlassesBridge } from './mock-glasses-bridge'

const OS_EVENT = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
  FOREGROUND_ENTER: 4,
  FOREGROUND_EXIT: 5,
  SYSTEM_EXIT: 7
}

function textPage(): HudPageBuild {
  return buildHudPage({ layout: 'text', header: 'h', body: 'b', footer: 'f' })
}

function listPage(items: string[]): HudPageBuild {
  return buildHudPage({ layout: 'list', header: 'h', items, footer: 'f' })
}

describe('MockGlassesBridge startup latch', () => {
  it('succeeds once then rejects the second createStartUpPage as invalid', async () => {
    const bridge = new MockGlassesBridge()
    await expect(bridge.createStartUpPage(textPage())).resolves.toBe('success')
    await expect(bridge.createStartUpPage(textPage())).resolves.toBe('invalid')
  })

  it('still spends the latch when the first page is invalid', async () => {
    const bridge = new MockGlassesBridge()
    const invalid: HudPageBuild = { containers: [] } // 0 containers violates the invariant
    await expect(bridge.createStartUpPage(invalid)).resolves.toBe('invalid')
    await expect(bridge.createStartUpPage(textPage())).resolves.toBe('invalid')
  })
})

describe('MockGlassesBridge invalid-page rejection', () => {
  it('rejects a page with no event-capture container', async () => {
    const bridge = new MockGlassesBridge()
    const page: HudPageBuild = {
      containers: [
        {
          kind: 'text',
          id: 1,
          name: 'a',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          content: 'x',
          isEventCapture: 0
        }
      ]
    }
    await expect(bridge.createStartUpPage(page)).resolves.toBe('invalid')
  })

  it('rebuildPage rejects invalid pages without mutating state', async () => {
    const bridge = new MockGlassesBridge()
    await bridge.createStartUpPage(textPage())
    const before = bridge.pageSnapshot()
    const bad: HudPageBuild = { containers: [] }
    await expect(bridge.rebuildPage(bad)).resolves.toBe(false)
    expect(bridge.pageSnapshot()).toBe(before)
  })
})

describe('MockGlassesBridge list selection / scroll boundary semantics', () => {
  it('moves selection internally without emitting until a boundary is hit', async () => {
    const bridge = new MockGlassesBridge()
    await bridge.createStartUpPage(listPage(['a', 'b', 'c']))
    const events: GlassesRawEvent[] = []
    bridge.onRawEvent((e) => events.push(e))

    expect(bridge.getListSelection()).toBe(0)
    // Already at top: scrolling up immediately hits the boundary and forwards.
    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.SCROLL_TOP })
    expect(events).toHaveLength(1)
    expect(bridge.getListSelection()).toBe(0)

    events.length = 0
    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.SCROLL_BOTTOM })
    expect(events).toHaveLength(0) // consumed: moved from 0 -> 1
    expect(bridge.getListSelection()).toBe(1)

    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.SCROLL_BOTTOM })
    expect(events).toHaveLength(0) // consumed: moved from 1 -> 2 (last item)
    expect(bridge.getListSelection()).toBe(2)

    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.SCROLL_BOTTOM })
    expect(events).toHaveLength(1) // boundary: already at last item, forwarded
    expect(bridge.getListSelection()).toBe(2)
  })

  it('click emits listItemIndex/listItemName, omitting index for item 0 by default', async () => {
    const bridge = new MockGlassesBridge()
    await bridge.createStartUpPage(listPage(['a', 'b', 'c']))
    const events: GlassesRawEvent[] = []
    bridge.onRawEvent((e) => events.push(e))

    bridge.simulateClick()
    expect(events).toHaveLength(1)
    expect(events[0]!.listItemIndex).toBeUndefined()
    expect(events[0]!.listItemName).toBe('a')

    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.SCROLL_BOTTOM }) // -> index 1
    events.length = 0
    bridge.simulateClick()
    expect(events[0]!.listItemIndex).toBe(1)
    expect(events[0]!.listItemName).toBe('b')
  })

  it('includes listItemIndex 0 when the omit-index-zero quirk is disabled', async () => {
    const bridge = new MockGlassesBridge({ omitIndexZeroQuirk: false })
    await bridge.createStartUpPage(listPage(['a', 'b']))
    const events: GlassesRawEvent[] = []
    bridge.onRawEvent((e) => events.push(e))
    bridge.simulateClick()
    expect(events[0]!.listItemIndex).toBe(0)
  })
})

describe('MockGlassesBridge exit-dialog polarity', () => {
  it('emits FOREGROUND_ENTER on open and FOREGROUND_EXIT when the user picks No', async () => {
    const bridge = new MockGlassesBridge()
    await bridge.createStartUpPage(textPage())
    const events: GlassesRawEvent[] = []
    bridge.onRawEvent((e) => events.push(e))

    await expect(bridge.shutDownPage(1)).resolves.toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]!.eventType).toBe(OS_EVENT.FOREGROUND_ENTER)
    expect(
      bridge.pageSnapshot()?.containers.some((c) => c.kind === 'text' && c.content.includes('Exit'))
    ).toBe(true)

    events.length = 0
    // Default selection is 'no'; a click resolves as cancel.
    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.CLICK })
    expect(events).toHaveLength(1)
    expect(events[0]!.eventType).toBe(OS_EVENT.FOREGROUND_EXIT)
    expect(bridge.isExitDialogOpen()).toBe(false)
  })

  it('emits SYSTEM_EXIT when the user scrolls to Yes and clicks', async () => {
    const bridge = new MockGlassesBridge()
    await bridge.createStartUpPage(textPage())
    const events: GlassesRawEvent[] = []
    bridge.onRawEvent((e) => events.push(e))

    await bridge.shutDownPage(1)
    events.length = 0
    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.SCROLL_BOTTOM }) // toggle no -> yes
    expect(events).toHaveLength(0)
    bridge.emitRaw({ source: 'sys', eventType: OS_EVENT.CLICK })
    expect(events).toHaveLength(1)
    expect(events[0]!.eventType).toBe(OS_EVENT.SYSTEM_EXIT)
  })
})

describe('MockGlassesBridge storage', () => {
  it('stores and deletes via empty string', async () => {
    const bridge = new MockGlassesBridge()
    await expect(bridge.getStoredValue('k')).resolves.toBe('')
    await bridge.setStoredValue('k', 'v')
    await expect(bridge.getStoredValue('k')).resolves.toBe('v')
    await bridge.setStoredValue('k', '')
    await expect(bridge.getStoredValue('k')).resolves.toBe('')
  })
})

describe('MockGlassesBridge flushRenders', () => {
  it('synchronously flushes a scheduled repaint', async () => {
    const bridge = new MockGlassesBridge()
    let repaints = 0
    bridge.setOnRepaint(() => repaints++)
    await bridge.createStartUpPage(textPage())
    expect(repaints).toBe(0)
    bridge.flushRenders()
    expect(repaints).toBe(1)
  })
})
