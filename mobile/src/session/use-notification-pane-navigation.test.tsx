import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import {
  notificationPaneTab,
  useNotificationPaneNavigation
} from './use-notification-pane-navigation'
import type { MobileSessionTab } from './mobile-session-route-types'
const route = vi.hoisted(() => ({ paneKey: '', setParams: vi.fn() }))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ paneKey: route.paneKey }),
  useRouter: () => ({ setParams: route.setParams })
}))
const leaf = '11111111-1111-4111-8111-111111111111'
const tabs: MobileSessionTab[] = [
  {
    type: 'terminal',
    id: 'first',
    parentTabId: 'tab-a',
    leafId: leaf,
    title: 'first',
    terminal: 'pty-a',
    isActive: true
  },
  {
    type: 'terminal',
    id: 'second',
    parentTabId: 'tab-b',
    leafId: leaf,
    title: 'agent',
    terminal: 'pty-b',
    isActive: false
  }
]
it('selects the originating split pane, not the first tab; closed and invalid panes fall back', () => {
  expect(notificationPaneTab(tabs, `tab-b:${leaf}`)).toBe(tabs[1])
  expect(notificationPaneTab(tabs, `closed:${leaf}`)).toBeUndefined()
  expect(notificationPaneTab(tabs, 'invalid')).toBeUndefined()
})
it('waits for tabs, switches through the existing action, and consumes the navigation request', async () => {
  route.paneKey = `tab-b:${leaf}`
  const switchSessionTab = vi.fn()
  function Probe({ loaded }: { loaded: boolean }) {
    useNotificationPaneNavigation({
      sessionTabs: loaded ? tabs : [],
      terminalsLoaded: loaded,
      switchSessionTab
    })
    return null
  }
  let renderer: ReturnType<typeof create>
  await act(async () => {
    renderer = create(createElement(Probe, { loaded: false }))
  })
  expect(switchSessionTab).not.toHaveBeenCalled()
  await act(async () => {
    renderer.update(createElement(Probe, { loaded: true }))
  })
  expect(switchSessionTab).toHaveBeenCalledExactlyOnceWith(tabs[1])
  expect(route.setParams).toHaveBeenCalledWith({ paneKey: '' })
  route.paneKey = ''
  await act(async () => {
    renderer.update(createElement(Probe, { loaded: true }))
  })
  expect(switchSessionTab).toHaveBeenCalledOnce()
  await act(async () => renderer.unmount())
})
