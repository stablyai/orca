import { createElement } from 'react'
import { Pressable } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SessionListLongPressOverride } from './session-list-long-press-context'
import { SessionListLongPressProvider } from './session-list-long-press'
import { SESSION_LIST_LONG_PRESS_MS } from './session-list-back'

const router = vi.hoisted(() => ({ dismissTo: vi.fn(), back: vi.fn() }))
const route = vi.hoisted(() => ({ pathname: '/h/host-1/tasks', hostId: 'host-1' }))
const haptics = vi.hoisted(() => ({ triggerEdgeBump: vi.fn() }))

vi.mock('expo-router', () => ({
  usePathname: () => route.pathname,
  useGlobalSearchParams: () => ({ hostId: route.hostId })
}))
vi.mock('./route-handoff', () => ({ useRouteHandoff: () => router }))
vi.mock('../platform/haptics', () => haptics)
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft', X: 'X' }))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))

function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <SessionListLongPressProvider>
      <NavBarButton accessibilityLabel="Back" icon={ChevronLeft} onPress={onPress} />
    </SessionListLongPressProvider>
  )
}

describe('a back button long-press', () => {
  it('resolves a deep route to the session list and leaves a tap unchanged', () => {
    route.pathname = '/h/mac/1/session/wt-9'
    route.hostId = 'mac/1'
    router.dismissTo.mockClear()
    router.back.mockClear()
    haptics.triggerEdgeBump.mockClear()
    const onPress = vi.fn()
    let renderer = create(createElement('View'))
    act(() => {
      renderer.update(createElement(BackButton, { onPress }))
    })
    const button = renderer.root.findByType(Pressable)
    expect(button?.props.delayLongPress).toBe(SESSION_LIST_LONG_PRESS_MS)
    expect(button?.props.accessibilityActions).toEqual([
      { name: 'longpress', label: 'Back to sessions' }
    ])
    act(() => button?.props.onPress())
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(router.dismissTo).not.toHaveBeenCalled()
    act(() => button?.props.onLongPress())
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/h/mac%2F1')
    expect(haptics.triggerEdgeBump).toHaveBeenCalledTimes(1)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('does not add a long-press on the session list itself', () => {
    route.pathname = '/h/host-1'
    route.hostId = 'host-1'
    let renderer = create(createElement('View'))
    act(() => {
      renderer.update(createElement(BackButton, { onPress: vi.fn() }))
    })
    expect(renderer.root.findByType(Pressable).props.onLongPress).toBeUndefined()
  })

  it('uses a session leave guard instead of dismissing past an unsaved draft', () => {
    route.pathname = '/h/mac/1/session/wt-9'
    route.hostId = 'mac/1'
    router.dismissTo.mockClear()
    const guarded = vi.fn()
    let renderer = create(createElement('View'))
    act(() => {
      renderer.update(
        <SessionListLongPressProvider>
          <SessionListLongPressOverride action={guarded}>
            <NavBarButton accessibilityLabel="Back" icon={ChevronLeft} onPress={vi.fn()} />
          </SessionListLongPressOverride>
        </SessionListLongPressProvider>
      )
    })
    act(() => renderer.root.findByType(Pressable).props.onLongPress())
    expect(guarded).toHaveBeenCalledTimes(1)
    expect(router.dismissTo).not.toHaveBeenCalled()
  })
})
