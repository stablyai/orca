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
