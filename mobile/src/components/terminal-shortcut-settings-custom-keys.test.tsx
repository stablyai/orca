import { createElement, useEffect, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import type { CustomKey } from '../terminal/terminal-custom-keys'

const CUSTOM_KEYS = 'orca:custom-accessory-keys'

const store = vi.hoisted(() => {
  const held: {
    values: Map<string, string>
    holdWrites: Promise<void> | null
    refuseWrites: boolean
  } = { values: new Map(), holdWrites: null, refuseWrites: false }
  return held
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      await store.holdWrites
      if (store.refuseWrites) {
        throw new Error('the store refused the write')
      }
      store.values.set(key, value)
    }
  }
}))
const hosts = vi.hoisted(() => {
  const make = (name: string) => {
    const Host = (props: { children?: ReactNode }): ReactNode => props.children ?? null
    Host.displayName = name
    return Host
  }
  return { View: make('View'), Text: make('Text'), Pressable: make('Pressable') }
})
const geometry = vi.hoisted(() => ({ keyboard: 0, duo: true, hasFoldDivision: false }))
vi.mock('../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => geometry.keyboard }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: geometry.hasFoldDivision ? 82 : 0,
    right: geometry.duo ? 84 : 0,
    bottom: 34,
    left: 0
  })
}))
vi.mock('../layout/reserved-regions', () => ({
  useReservedRegions: () => ({
    occlusions: geometry.duo
      ? [{ x: 867, y: 0, width: 84, height: 124 }]
      : geometry.hasFoldDivision
        ? [{ x: 535, y: 0, width: 134, height: 82 }]
        : [],
    divisions: [],
    hasFoldDivision: geometry.hasFoldDivision,
    windowSafeArea: null
  })
}))
import { SideRailProvider, useSideRailStrip } from '../layout/side-rail'
import { usePageFoldDivision } from '../mobile-web-shell/page-fold-division'
let drawnHeight: number | null = null
let pagePadAvailable: boolean | undefined
function GeometryProbe() {
  drawnHeight = useSideRailStrip()?.height ?? null
  pagePadAvailable = usePageFoldDivision().geometry.directionPadAvailable
  return null
}
vi.mock('react-native', () => ({
  useWindowDimensions: () =>
    geometry.hasFoldDivision ? { width: 669, height: 951 } : { width: 951, height: 669 },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios }
}))
vi.mock('./MobileSwitch', () => ({ MobileSwitch: hosts.View }))
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect])
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: hosts.View,
  ChevronRight: hosts.View,
  X: hosts.View
}))
vi.mock('./BottomDrawer', () => ({ BottomDrawer: hosts.View }))
const lists = vi.hoisted(() => {
  const held: {
    custom: { items: CustomKey[]; onReorder: (ids: string[]) => void } | null
    builtIn: { items: { id: string }[]; onReorder: (ids: string[]) => void } | null
  } = { custom: null, builtIn: null }
  return held
})
vi.mock('./DragReorderList', () => ({
  DragReorderList: (props: {
    items: { id: string }[]
    renderRow: (item: { id: string }) => ReactNode
    onReorder: (ids: string[]) => void
  }): ReactNode => {
    if (props.items.some((item) => item.id.startsWith('custom-'))) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the custom-key list is the only one whose ids start with `custom-`.
      lists.custom = props as unknown as { items: CustomKey[]; onReorder: (ids: string[]) => void }
    }
    if (props.items.some((item) => item.id === 'escape')) {
      lists.builtIn = props
    }
    return props.items.map((item) => props.renderRow(item))
  }
}))

import { TerminalShortcutSettings } from './TerminalShortcutSettings'

const keys: CustomKey[] = ['a', 'b', 'c'].map((name) => ({
  id: `custom-${name}`,
  label: name,
  bytes: name,
  enter: false
}))

function stored(): string[] {
  const raw = store.values.get(CUSTOM_KEYS)
  const parsed: CustomKey[] = raw ? JSON.parse(raw) : []
  return parsed.map((key) => key.id)
}

function shown(): string[] {
  return lists.custom?.items.map((key) => key.id) ?? []
}

let renderer: ReactTestRenderer | null = null

function settingsScreen() {
  return createElement(
    SideRailProvider,
    null,
    createElement(GeometryProbe),
    createElement(TerminalShortcutSettings, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked reorder list never reads the scroll bindings.
      scrollRef: {} as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      scrollOffsetY: {} as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      scrollContentHeight: {} as never,
      onDragActiveChange: () => {}
    })
  )
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(settingsScreen())
  })
}

function pressRemove(label: string): void {
  const button = renderer?.root.find(
    (node) => node.type === hosts.Pressable && node.props.accessibilityLabel === `Remove ${label}`
  )
  act(() => button?.props.onPress())
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  geometry.keyboard = 0
  geometry.duo = true
  geometry.hasFoldDivision = false
  store.values = new Map([[CUSTOM_KEYS, JSON.stringify(keys)]])
  store.holdWrites = null
  store.refuseWrites = false
  lists.custom = null
  lists.builtIn = null
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('custom shortcuts in terminal settings', () => {
  it('keeps a key removed when the list is reordered before the removal is saved', async () => {
    await mount()
    let releaseWrites: () => void = () => {}
    store.holdWrites = new Promise((resolve) => {
      releaseWrites = resolve
    })
    pressRemove('b')
    act(() => lists.custom?.onReorder(['custom-c', 'custom-a']))
    releaseWrites()
    await settle()
    expect(shown()).toEqual(['custom-c', 'custom-a'])
    expect(stored()).toEqual(['custom-c', 'custom-a'])
  })

  it('shows the key again when the store refuses its removal', async () => {
    await mount()
    store.refuseWrites = true
    pressRemove('b')
    expect(shown()).toEqual(['custom-a', 'custom-c'])
    await settle()
    expect(shown()).toEqual(['custom-a', 'custom-b', 'custom-c'])
    expect(stored()).toEqual(['custom-a', 'custom-b', 'custom-c'])
  })
})

it('persists the independent D-pad switch and custom visibility through settings reopen', async () => {
  await mount()
  const switchFor = (label: string) => renderer!.root.findByProps({ accessibilityLabel: label })
  expect(switchFor('Show D-pad').props.value).toBe(true)
  expect(switchFor('Show Arrow Up shortcut').props.value).toBe(false)
  act(() => switchFor('Show D-pad').props.onValueChange(false))
  act(() => switchFor('Show Escape shortcut').props.onValueChange(false))
  act(() => switchFor('Show Arrow Up shortcut').props.onValueChange(true))
  act(() => lists.builtIn?.onReorder(lists.builtIn.items.map((key) => key.id).toReversed()))
  act(() => switchFor('Show a shortcut').props.onValueChange(false))
  act(() => lists.custom?.onReorder(['custom-c', 'custom-b', 'custom-a']))
  await settle()
  expect((await loadTerminalAccessoryLayout()).directionPadEnabled).toBe(false)
  act(() => renderer?.unmount())
  await mount()
  expect(switchFor('Show D-pad').props.value).toBe(false)
  expect(switchFor('Show Escape shortcut').props.value).toBe(false)
  expect(switchFor('Show Arrow Up shortcut').props.value).toBe(true)
  expect((await loadTerminalAccessoryLayout()).visibleBuiltInIds.indexOf('arrowUp')).toBeLessThan(
    (await loadTerminalAccessoryLayout()).visibleBuiltInIds.indexOf('tab')
  )
  expect(switchFor('Show a shortcut').props.value).toBe(false)
  expect(shown()).toEqual(['custom-c', 'custom-b', 'custom-a'])
})

it('keeps Duo defaults while the keyboard clips the rail, including when saving another shortcut', async () => {
  await mount()
  geometry.keyboard = 400
  await act(async () => renderer!.update(settingsScreen()))
  const switchFor = (label: string) => renderer!.root.findByProps({ accessibilityLabel: label })
  expect(drawnHeight).toBe(145)
  expect.soft(pagePadAvailable).toBe(true)
  expect.soft(switchFor('Show Arrow Up shortcut').props.value).toBe(false)
  act(() => switchFor('Show Escape shortcut').props.onValueChange(false))
  await settle()
  expect((await loadTerminalAccessoryLayout()).visibleBuiltInIds).not.toContain('arrowUp')
  act(() => switchFor('Show Arrow Up shortcut').props.onValueChange(true))
  await settle()
  act(() => renderer!.unmount())
  geometry.keyboard = 0
  await mount()
  expect(switchFor('Show Arrow Up shortcut').props.value).toBe(true)
})

it('retains navigation defaults on a device without a D-pad rail', async () => {
  geometry.duo = false
  geometry.keyboard = 400
  await mount()
  expect(pagePadAvailable).toBe(false)
  expect(
    renderer!.root.findByProps({ accessibilityLabel: 'Show Arrow Up shortcut' }).props.value
  ).toBe(true)
})

it('uses inactive fold capability for a cold no-rail screen and preserves explicit D-pad disable', async () => {
  geometry.duo = false
  geometry.hasFoldDivision = true
  await mount()
  const switchFor = (label: string) => renderer!.root.findByProps({ accessibilityLabel: label })
  expect(drawnHeight).toBeNull()
  expect.soft(pagePadAvailable).toBe(true)
  expect.soft(switchFor('Show Arrow Up shortcut').props.value).toBe(false)
  act(() => switchFor('Show D-pad').props.onValueChange(false))
  await settle()
  act(() => renderer!.unmount())
  await mount()
  expect(switchFor('Show D-pad').props.value).toBe(false)
  expect(switchFor('Show Arrow Up shortcut').props.value).toBe(false)
})
