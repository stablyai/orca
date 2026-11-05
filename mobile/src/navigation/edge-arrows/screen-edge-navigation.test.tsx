import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalEdgeNavigationProvider } from './GlobalEdgeNavigationProvider'
import { ScreenEdgeNavigationOverlay } from './ScreenEdgeNavigationOverlay'
import {
  PaneEdgeNavigationOverlay,
  type EdgeDirection,
  type EdgeNavigationTarget
} from './edge-navigation-context'
import { computeZoomStableHudMetrics } from './use-zoom-stable-viewport'
import { useSessionEdgeNavigation } from '../../session/use-session-edge-navigation'
import type { MobileSessionController } from '../../session/use-mobile-session-controller'

const storage = vi.hoisted(() => new Map<string, string>())
const appState = vi.hoisted(() => ({ listener: (_state: string) => {} }))
const platformState = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'web' }))

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
  Platform: platformState,
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
  platformState.OS = 'ios'
  vi.useRealTimers()
})

describe('ScreenEdgeNavigationOverlay (sticky pane 4-side & zoom-stable gamepad controls)', () => {
  it('renders Floating Orbs (0.5 rest opacity) and hides the quick-switcher dock by default when storage is unset', async () => {
    const events: string[] = []
    const target: EdgeNavigationTarget = {
      id: 'session-terminal-default-orbs',
      kind: 'terminal',
      preparePress: (direction: EdgeDirection) => ({
        tap: () => {
          events.push(`tap:${direction}`)
        }
      })
    }

    await act(async () => {
      renderer = create(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(PaneEdgeNavigationOverlay, { target, bottomInset: 180 })
        )
      )
    })

    const layer = renderer!.root.findByProps({ testID: 'pane-edge-arrows-layer' })
    act(() => {
      layer.props.onLayout({ nativeEvent: { layout: { width: 360, height: 420 } } })
    })

    expect(renderer!.root.findAllByProps({ testID: 'edge-arrow-settings-dock' })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ testID: 'edge-arrow-flavour-chip' })).toHaveLength(0)

    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const btn = renderer!.root.findByProps({ testID: `edge-arrow-${direction}` })
      expect(btn.props['data-flavour']).toBe('orbs')
      act(() => {
        btn.props.onPressIn()
        btn.props.onPressOut()
        btn.props.onPress()
      })
    }
    expect(events).toEqual(['tap:up', 'tap:down', 'tap:left', 'tap:right'])
  })

  it('places opt-in arrow-keys settings dock bottom-right, lifts above bottomInset/bottomRightOffset, repeats on hold, and cycles Orbs -> Gamepad -> Pills -> Strips -> Orbs', async () => {
    vi.useFakeTimers()
    storage.set(
      'orca:terminal-accessory-layout',
      JSON.stringify({
        version: 2,
        orderedBuiltInIds: ['escape', 'tab'],
        visibleBuiltInIds: ['escape', 'tab'],
        edgeSwitcherChipHidden: false
      })
    )
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
          createElement(PaneEdgeNavigationOverlay, {
            target,
            bottomInset: 260,
            bottomRightOffset: 50
          })
        )
      )
    })

    const layer = renderer!.root.findByProps({ testID: 'pane-edge-arrows-layer' })
    expect(layer.props.style).toEqual(expect.arrayContaining([{ bottom: 260 }]))
    act(() => {
      layer.props.onLayout({ nativeEvent: { layout: { width: 360, height: 420 } } })
    })

    // Bottom-right settings dock sits at bottom: 6 + 50 = 56, right: 8 (never top-right)
    const settingsDock = renderer!.root.findByProps({ testID: 'edge-arrow-settings-dock' })
    expect(settingsDock.props.style).toEqual(expect.arrayContaining([{ bottom: 56, right: 8 }]))

    const upStyle = renderer!.root
      .findByProps({ testID: 'edge-arrow-up' })
      .props.style({ pressed: false })
    const downStyle = renderer!.root
      .findByProps({ testID: 'edge-arrow-down' })
      .props.style({ pressed: false })
    expect(upStyle).toEqual(expect.arrayContaining([{ top: 6, left: 161 }]))
    expect(downStyle).toEqual(expect.arrayContaining([{ bottom: 6, left: 161 }]))

    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const btn = renderer!.root.findByProps({ testID: `edge-arrow-${direction}` })
      expect(btn.props['data-flavour']).toBe('orbs')
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

    // Tapping bottom-right settings icon opens the mode sheet directly
    await act(async () => {
      renderer!.root.findByProps({ testID: 'edge-arrow-settings-button' }).props.onPress()
    })
    expect(renderer!.root.findAllByType('Modal' as unknown as React.ElementType)).toHaveLength(1)

    // Cycle Orbs -> Gamepad -> Pills -> Strips -> Orbs via bottom-right quick-switcher chip
    await act(async () => {
      renderer!.root.findByProps({ testID: 'edge-arrow-flavour-chip' }).props.onPress()
    })
    expect(renderer!.root.findByProps({ testID: 'edge-arrow-up' }).props['data-flavour']).toBe(
      'gamepad'
    )
    expect(renderer!.root.findByProps({ testID: 'gamepad-dpad-cluster' })).toBeDefined()
    expect(renderer!.root.findByProps({ testID: 'gamepad-action-cluster' })).toBeDefined()

    await act(async () => {
      renderer!.root.findByProps({ testID: 'edge-arrow-flavour-chip' }).props.onPress()
    })
    expect(renderer!.root.findByProps({ testID: 'edge-arrow-up' }).props['data-flavour']).toBe(
      'pills'
    )

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

  it('routes useSessionEdgeNavigation across terminal D-pad/action chords (Tab, Alt+M, Esc, Enter) and content-window tab switching', async () => {
    const sentInputs: unknown[] = []
    const switchedTabs: string[] = []
    const leftSession = vi.fn()
    let modifierState: { ctrl: 'once' | 'off'; alt: 'off'; shift: 'off' } = {
      ctrl: 'once',
      alt: 'off',
      shift: 'off'
    }

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
          modifiers: modifierState,
          takeModifiers: () => {
            const snapshot = modifierState
            modifierState = { ctrl: 'off', alt: 'off', shift: 'off' }
            return snapshot
          }
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

    storage.set(
      'orca:terminal-accessory-layout',
      JSON.stringify({
        version: 2,
        orderedBuiltInIds: ['escape', 'tab'],
        visibleBuiltInIds: ['escape', 'tab'],
        edgeNavigationMode: 'gamepad'
      })
    )

    await act(async () => {
      renderer = create(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(SessionHarness, { contentWindow: false })
        )
      )
    })

    // D-pad right with Ctrl once -> Ctrl+Right
    const rightBtn = renderer!.root.findByProps({ testID: 'edge-arrow-right' })
    act(() => {
      rightBtn.props.onPressIn()
      rightBtn.props.onPressOut()
      rightBtn.props.onPress()
    })
    expect(sentInputs).toEqual([{ bytes: '\x1b[1;5C' }])

    // Gamepad diamond action cluster -> Tab (north), Alt+M (west), Esc (east), Enter (south)
    sentInputs.length = 0
    for (const id of ['north', 'west', 'east', 'south'] as const) {
      act(() => {
        renderer!.root.findByProps({ testID: `gamepad-action-${id}` }).props.onPress()
      })
    }
    expect(sentInputs).toEqual([
      { bytes: '\t' },
      { bytes: '\x1bm' },
      { bytes: '\x1b' },
      { bytes: '\r' }
    ])

    await act(async () => {
      renderer!.update(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(SessionHarness, { contentWindow: true })
        )
      )
    })

    // In content-window mode, Gamepad West triggers previous-tab fallback
    act(() => {
      renderer!.root.findByProps({ testID: 'gamepad-action-west' }).props.onPress()
    })
    expect(switchedTabs).toEqual(['tab-a'])
  })

  it('counter-scales and anchors HUD metrics against pinch-zoomed visualViewport', () => {
    const unzoomed = computeZoomStableHudMetrics(
      { left: 0, top: 60, width: 390, height: 700 },
      { scale: 1, offsetLeft: 0, offsetTop: 0, width: 390, height: 760 }
    )
    expect(unzoomed.isZoomAdjusted).toBe(false)
    expect(unzoomed.inverseScale).toBe(1)
    expect(unzoomed.width).toBe(390)
    expect(unzoomed.height).toBe(700)

    const pinched2x = computeZoomStableHudMetrics(
      { left: 0, top: 60, width: 390, height: 700 },
      { scale: 2, offsetLeft: 80, offsetTop: 120, width: 195, height: 350 }
    )
    expect(pinched2x.isZoomAdjusted).toBe(true)
    expect(pinched2x.scale).toBe(2)
    expect(pinched2x.inverseScale).toBe(0.5)
    expect(pinched2x.left).toBe(80)
    expect(pinched2x.top).toBe(60)
    expect(pinched2x.width).toBe(390)
    expect(pinched2x.height).toBe(700)
  })

  it('renders 4-side edge arrow keys and opt-in dock controls half-transparent (0.5) at rest and brightens on press', async () => {
    storage.set(
      'orca:terminal-accessory-layout',
      JSON.stringify({
        version: 2,
        orderedBuiltInIds: ['escape', 'tab'],
        visibleBuiltInIds: ['escape', 'tab'],
        edgeSwitcherChipHidden: false
      })
    )
    const target: EdgeNavigationTarget = {
      id: 'session-terminal-opacity',
      kind: 'terminal',
      preparePress: () => ({ tap: () => {} })
    }

    await act(async () => {
      renderer = create(
        createElement(
          GlobalEdgeNavigationProvider,
          null,
          createElement(PaneEdgeNavigationOverlay, { target })
        )
      )
    })

    const layer = renderer!.root.findByProps({ testID: 'pane-edge-arrows-layer' })
    act(() => {
      layer.props.onLayout({ nativeEvent: { layout: { width: 360, height: 420 } } })
    })

    const resolveEffectiveOpacity = (styleEntries: readonly unknown[]): number | undefined => {
      let current: number | undefined
      for (const entry of styleEntries) {
        if (entry && typeof entry === 'object' && 'opacity' in entry) {
          const candidate = (entry as { opacity?: unknown }).opacity
          if (typeof candidate === 'number') {
            current = candidate
          }
        }
      }
      return current
    }

    // Check rest (0.5) and pressed (0.92) opacity across Orbs -> Gamepad -> Pills -> Strips
    for (const expectedFlavour of ['orbs', 'gamepad', 'pills', 'strips'] as const) {
      for (const direction of ['up', 'down', 'left', 'right'] as const) {
        const arrow = renderer!.root.findByProps({ testID: `edge-arrow-${direction}` })
        expect(arrow.props['data-flavour']).toBe(expectedFlavour)
        expect(resolveEffectiveOpacity(arrow.props.style({ pressed: false }))).toBe(0.5)
        expect(resolveEffectiveOpacity(arrow.props.style({ pressed: true }))).toBe(0.92)
      }
      const chip = renderer!.root.findByProps({ testID: 'edge-arrow-flavour-chip' })
      expect(resolveEffectiveOpacity(chip.props.style({ pressed: false }))).toBe(0.5)
      expect(resolveEffectiveOpacity(chip.props.style({ pressed: true }))).toBe(0.95)
      await act(async () => {
        chip.props.onPress()
      })
    }

    // Cycle once more from Orbs -> Gamepad to assert action diamond rest/pressed opacity directly
    await act(async () => {
      renderer!.root.findByProps({ testID: 'edge-arrow-flavour-chip' }).props.onPress()
    })
    for (const id of ['north', 'west', 'east', 'south'] as const) {
      const action = renderer!.root.findByProps({ testID: `gamepad-action-${id}` })
      expect(resolveEffectiveOpacity(action.props.style({ pressed: false }))).toBe(0.5)
      expect(resolveEffectiveOpacity(action.props.style({ pressed: true }))).toBe(0.92)
    }
  })
})
