import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalEdgeNavigationProvider } from './GlobalEdgeNavigationProvider'
import { ScreenEdgeNavigationOverlay } from './ScreenEdgeNavigationOverlay'
import { type EdgeDirection, type EdgeNavigationTarget } from './edge-navigation-context'
import { useSessionEdgeNavigation } from '../../session/use-session-edge-navigation'
import type { MobileSessionController } from '../../session/use-mobile-session-controller'

const storage = vi.hoisted(() => new Map<string, string>())
const appState = vi.hoisted(() => ({ listener: (_state: string) => {} }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key)
    }),
    multiGet: vi.fn(async (keys: readonly string[]) =>
      keys.map((key) => [key, storage.get(key) ?? null] as const)
    )
  }
}))

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: (_name: string, listener: (state: string) => void) => {
      appState.listener = listener
      return { remove() {} }
    }
  },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }
  }
}))

vi.mock('../../platform/haptics', () => ({
  triggerSelection: vi.fn()
}))

let renderer: ReturnType<typeof create> | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  storage.clear()
  vi.useRealTimers()
})

describe('ScreenEdgeNavigationOverlay (sticky pane 4-side controls)', () => {
  it('anchors 4-side arrows sticky inside pane bounds, lifts above bottomInset, repeats on hold, and cycles all 3 flavours', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    let repeatTimer: ReturnType<typeof setInterval> | null = null
    const target: EdgeNavigationTarget = {
      id: 'session-terminal',
      kind: 'terminal',
      preparePress: (direction: EdgeDirection) => {
        let held = false
        return {
          tap: () => {
            if (!held) {
              events.push(`tap:${direction}`)
            }
          },
          hold: () => {
            held = true
            events.push(`hold:${direction}`)
            repeatTimer = setInterval(() => {
              events.push(`repeat:${direction}`)
            }, 60)
          },
          stop: () => {
            if (repeatTimer !== null) {
              clearInterval(repeatTimer)
              repeatTimer = null
            }
            events.push(`stop:${direction}`)
          }
        }
      }
    }

    await act(async () => {
      renderer = create(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(ScreenEdgeNavigationOverlay, { target, bottomInset: 260 })
        )
      )
    })

    const layer = renderer!.root.findByProps({ testID: 'pane-edge-arrows-layer' })
    expect(layer.props.style).toEqual(expect.arrayContaining([{ bottom: 260 }]))
    act(() => {
      layer.props.onLayout({ nativeEvent: { layout: { width: 360, height: 420 } } })
    })

    const upStyle = renderer!.root
      .findByProps({ testID: 'edge-arrow-up' })
      .props.style({ pressed: false })
    const downStyle = renderer!.root
      .findByProps({ testID: 'edge-arrow-down' })
      .props.style({ pressed: false })
    expect(upStyle).toEqual(expect.arrayContaining([{ top: 6, left: 152 }]))
    expect(downStyle).toEqual(expect.arrayContaining([{ bottom: 6, left: 152 }]))

    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const btn = renderer!.root.findByProps({ testID: `edge-arrow-${direction}` })
      expect(btn.props['data-flavour']).toBe('pills')
      act(() => {
        btn.props.onPressIn()
        btn.props.onPressOut()
        btn.props.onPress()
      })
    }
    expect(events).toEqual(['tap:up', 'tap:down', 'tap:left', 'tap:right'])

    events.length = 0
    const downBtn = renderer!.root.findByProps({ testID: 'edge-arrow-down' })
    act(() => {
      downBtn.props.onPressIn()
      downBtn.props.onLongPress()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130)
    })
    act(() => {
      downBtn.props.onPressOut()
      downBtn.props.onPress()
    })
    expect(events).toEqual(['hold:down', 'repeat:down', 'repeat:down', 'stop:down'])

    // Cycle Pills (default) -> Strips -> Orbs -> Pills via in-pane quick-switcher chip
    await act(async () => {
      renderer!.root.findByProps({ testID: 'edge-arrow-flavour-chip' }).props.onPress()
    })
    expect(renderer!.root.findByProps({ testID: 'edge-arrow-up' }).props['data-flavour']).toBe(
      'strips'
    )

    await act(async () => {
      renderer!.root.findByProps({ testID: 'edge-arrow-flavour-chip' }).props.onPress()
    })
    expect(renderer!.root.findByProps({ testID: 'edge-arrow-up' }).props['data-flavour']).toBe(
      'orbs'
    )

    await act(async () => {
      renderer!.root.findByProps({ testID: 'edge-arrow-flavour-chip' }).props.onPress()
    })
    expect(renderer!.root.findByProps({ testID: 'edge-arrow-up' }).props['data-flavour']).toBe(
      'pills'
    )
  })

  it('hides sticky pane controls while obscured by a session drawer or sheet', async () => {
    const target: EdgeNavigationTarget = {
      id: 'agent-chat-1',
      kind: 'agent-session',
      obscured: true,
      preparePress: () => ({ tap: () => {} })
    }
    await act(async () => {
      renderer = create(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(ScreenEdgeNavigationOverlay, { target })
        )
      )
    })
    expect(renderer!.root.findAllByProps({ testID: 'pane-edge-arrows-layer' })).toHaveLength(0)
  })

  it('routes useSessionEdgeNavigation between terminal key chords and content-window tab switching', async () => {
    const sentInputs: unknown[] = []
    const switchedTabs: string[] = []
    const leftSession = vi.fn()

    function SessionHarness({ contentWindow }: { contentWindow: boolean }) {
      const tabA = {
        id: 'tab-a',
        type: 'markdown' as const,
        title: 'README.md',
        relativePath: 'README.md'
      }
      const tabB = {
        id: 'tab-b',
        type: 'file' as const,
        title: 'index.ts',
        relativePath: 'index.ts'
      }
      const controller = {
        hostId: 'local',
        worktreeId: 'wt-1',
        activeSessionTab: contentWindow
          ? tabB
          : { id: 'term-1', type: 'terminal', terminal: 'pty-1', title: 'zsh' },
        canSend: true,
        visibleTabs: contentWindow ? [tabA, tabB] : [],
        dockKeys: {
          modifiers: { ctrl: 'once', alt: 'off', shift: 'off' },
          takeModifiers: () => ({ ctrl: 'once', alt: 'off', shift: 'off' })
        },
        prepareAccessoryPress: (input: unknown) => ({
          tap: () => {
            sentInputs.push(input)
            return Promise.resolve(true)
          },
          hold: vi.fn()
        }),
        stopAccessoryRepeat: vi.fn(),
        switchSessionTab: (tab: { id: string }) => {
          switchedTabs.push(tab.id)
        },
        requestLeaveSession: leftSession
      } as unknown as MobileSessionController

      const { terminalTarget, contentTarget } = useSessionEdgeNavigation({
        controller,
        obscured: false
      })
      return createElement(ScreenEdgeNavigationOverlay, {
        target: contentWindow ? contentTarget : terminalTarget
      })
    }

    await act(async () => {
      renderer = create(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(SessionHarness, { contentWindow: false })
        )
      )
    })

    const rightBtn = renderer!.root.findByProps({ testID: 'edge-arrow-right' })
    act(() => {
      rightBtn.props.onPressIn()
      rightBtn.props.onPressOut()
      rightBtn.props.onPress()
    })
    expect(sentInputs).toEqual([{ bytes: '\x1b[1;5C' }])

    await act(async () => {
      renderer!.update(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(SessionHarness, { contentWindow: true })
        )
      )
    })

    const leftBtn = renderer!.root.findByProps({ testID: 'edge-arrow-left' })
    act(() => {
      leftBtn.props.onPressIn()
      leftBtn.props.onPressOut()
      leftBtn.props.onPress()
    })
    expect(switchedTabs).toEqual(['tab-a'])
  })
})
