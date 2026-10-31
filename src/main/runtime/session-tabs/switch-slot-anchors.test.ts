import { expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { AGENT_SESSION_SWITCH_HOST_MS } from '../../../shared/agent-session-switch-execution'
import { SwitchSlotAnchors } from './switch-slot-anchors'

const terminal = (tabId: string) => ({
  type: 'terminal' as const,
  id: `${tabId}::leaf`,
  parentTabId: tabId,
  leafId: 'leaf',
  title: tabId,
  isActive: false
})
const frame = (tabIds: string[]): RuntimeMobileSessionTabsSnapshot => ({
  worktree: 'ws',
  publicationEpoch: 'epoch',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: tabIds.map(terminal)
})

it('names the slot on every frame for the destination’s life, renderer frames first included', () => {
  const anchors = new SwitchSlotAnchors()
  anchors.record('ws', 'switched', { replaces: { tabId: 'agent-session:chat' } })
  // The window republished before main's own write: its rows never carry the anchor.
  expect(anchors.stamp(frame(['other'])).tabs).toEqual([terminal('other')])
  const shown = anchors.stamp(frame(['switched', 'other']))
  expect(shown.tabs[0]).toMatchObject({ replaces: { tabId: 'agent-session:chat' } })
  expect(anchors.stamp(frame(['switched'])).tabs[0]).toHaveProperty('replaces')
  // The destination left: the anchor dies with it and a later tab of that id gets none.
  anchors.stamp(frame(['other']))
  expect(anchors.stamp(frame(['switched'])).tabs[0]).not.toHaveProperty('replaces')
})

it('drops an anchor whose switch never placed its destination', () => {
  let now = 0
  const anchors = new SwitchSlotAnchors(() => now)
  anchors.record('ws', 'never-placed', { after: { tabId: 'source' } })
  now = AGENT_SESSION_SWITCH_HOST_MS + 1
  anchors.stamp(frame([]))
  expect(anchors.stamp(frame(['never-placed'])).tabs[0]).not.toHaveProperty('after')
})

it('keeps the anchor a first attempt left when a retry after a lost answer places nothing', () => {
  const anchors = new SwitchSlotAnchors()
  const slot = { replaces: { tabId: 'agent-session:chat' } }
  expect(anchors.record('ws', 'switched', slot)).toBe(true)
  anchors.stamp(frame(['switched']))
  // The retry names the same slot; its layout owner reports nothing closed.
  expect(anchors.record('ws', 'switched', slot)).toBe(false)
  anchors.forget('ws', 'switched')
  expect(anchors.stamp(frame(['switched'])).tabs[0]).toMatchObject(slot)
})

it.each([100, 1_000])('stamps %i rows in one pass, and touches none without an anchor', (n) => {
  const ids = Array.from({ length: n }, (_, index) => `tab-${index}`)
  let reads = 0
  // Every row read goes through its index's getter.
  const counted = (snapshot: RuntimeMobileSessionTabsSnapshot) => {
    const tabs = [...snapshot.tabs]
    tabs.forEach((row, index) =>
      Object.defineProperty(tabs, index, {
        get: () => {
          reads += 1
          return row
        }
      })
    )
    return { ...snapshot, tabs }
  }
  const anchors = new SwitchSlotAnchors()
  anchors.record('elsewhere', 'switched', { after: { tabId: 'source' } })
  const plain = counted(frame(ids))
  expect(anchors.stamp(plain)).toBe(plain)
  expect(reads).toBe(0)
  anchors.record('ws', 'tab-7', { after: { tabId: 'source' } })
  const source = frame(ids)
  const stamped = anchors.stamp(counted(source))
  expect(reads).toBeLessThanOrEqual(2 * n)
  // Only the destination's row is new.
  expect(stamped.tabs.filter((row, index) => row !== source.tabs[index])).toEqual([
    { ...source.tabs[7], after: { tabId: 'source' } }
  ])
})
