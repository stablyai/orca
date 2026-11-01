import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSessionRouteScreen } from './MobileSessionRouteScreen'

// Mocked react-native components are string tags that ReactTestInstance's ElementType omits.
function hostType(node: ReactTestInstance): unknown {
  return node.type
}

const state = vi.hoisted(() => ({
  terminalPreferencesReady: false,
  accessoryPreferencesReady: false,
  nativeChatController: { sessionViewReady: false }
}))
const mounts = vi.hoisted(() => ({ count: 0 }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  View: 'View'
}))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('./use-mobile-session-controller', () => ({ useMobileSessionController: () => state }))
vi.mock('./MobileSessionSurface', async () => {
  const react = await import('react')
  return {
    MobileSessionSurface: () => {
      react.useEffect(() => {
        mounts.count += 1
      }, [])
      return react.createElement('ReadySession')
    }
  }
})

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('first visible session appearance', () => {
  it.each(['terminal', 'accessory', 'chat'] as const)(
    'waits for the saved %s setting before mounting the session',
    (waiting) => {
      state.terminalPreferencesReady = waiting !== 'terminal'
      state.accessoryPreferencesReady = waiting !== 'accessory'
      state.nativeChatController.sessionViewReady = waiting !== 'chat'
      mounts.count = 0
      const render = () =>
        act(() => {
          if (renderer) {
            renderer.update(createElement(MobileSessionRouteScreen))
          } else {
            renderer = create(createElement(MobileSessionRouteScreen))
          }
        })
      const expectPreparing = () => {
        expect(renderer?.root.findAll((node) => hostType(node) === 'ReadySession')).toHaveLength(0)
        expect(
          renderer?.root.findAll((node) => hostType(node) === 'ActivityIndicator')
        ).toHaveLength(1)
        expect(mounts.count).toBe(0)
      }
      render()
      expectPreparing()
      state.terminalPreferencesReady = true
      state.accessoryPreferencesReady = true
      state.nativeChatController.sessionViewReady = true
      render()
      expect(renderer?.root.findAll((node) => hostType(node) === 'ReadySession')).toHaveLength(1)
      expect(mounts.count).toBe(1)
      render()
      expect(mounts.count).toBe(1)
    }
  )
})
