import { describe, expect, it } from 'vitest'
import { notificationPaneTab } from './notification-pane-tab'
import type { MobileSessionTab } from './mobile-session-route-types'

const leaf = '10000000-0000-4000-8000-000000000001'
const tabs: MobileSessionTab[] = [
  {
    type: 'terminal',
    id: 'first',
    terminal: 'terminal:first',
    title: 'First chat',
    isActive: true
  },
  {
    type: 'terminal',
    id: 'second',
    parentTabId: 'group',
    leafId: leaf,
    terminal: 'terminal:second',
    title: 'Second chat',
    isActive: false
  }
]

describe('conversation route tab selection', () => {
  it('selects the exact launch handle even when the host has not supplied pane topology', () => {
    expect(notificationPaneTab(tabs, 'terminal:second')).toBe(tabs[1])
    expect(notificationPaneTab(tabs, 'second')).toBe(tabs[1])
  })

  it('keeps modern stable pane selection inside the routed workspace inventory', () => {
    expect(notificationPaneTab(tabs, `group:${leaf}`)).toBe(tabs[1])
    expect(notificationPaneTab(tabs.slice(0, 1), `group:${leaf}`)).toBeUndefined()
  })

  it('never substitutes the active chat when the requested conversation is missing', () => {
    expect(notificationPaneTab(tabs, 'terminal:missing')).toBeUndefined()
  })
})
