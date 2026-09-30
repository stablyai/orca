import { createElement, useEffect, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Animated from 'react-native-reanimated'
import { useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import type { CustomKey } from './CustomKeyModal'
import type { DragReorderListProps } from './DragReorderList'

const state = vi.hoisted(() => {
  const held: {
    storage: Map<string, string>
    refresh: () => void
    foreground: (value: string) => void
    readLayout: (() => Promise<string | null>) | null
    writeLayout: (() => Promise<void>) | null
  } = {
    storage: new Map<string, string>(),
    refresh: () => {},
    foreground: (_state: string) => {},
    readLayout: null,
    writeLayout: null
  }
  return held
})
const hosts = vi.hoisted(() => {
  const make = () => (props: { children?: ReactNode }) => props.children ?? null
  return { View: make(), Text: make(), Pressable: make(), Switch: make() }
})
vi.mock('react-native', () => ({
  ...hosts,
  AppState: {
    addEventListener: (_event: string, callback: (value: string) => void) => {
      state.foreground = callback
      return { remove: vi.fn() }
    }
  },
  Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios },
  StyleSheet: { create: <T,>(value: T) => value }
}))
vi.mock('react-native-reanimated', () => ({
  default: {},
  useAnimatedRef: () => ({ current: null }),
  useSharedValue: (value: number) => ({ value })
}))
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => {
    state.refresh = callback
    useEffect(callback, [callback])
  }
}))
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, X: () => null }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) =>
      state.readLayout ? state.readLayout() : (state.storage.get(key) ?? null),
    setItem: async (key: string, value: string) => {
      await state.writeLayout?.()
      state.storage.set(key, value)
    }
  }
}))
vi.mock('./CustomKeyModal', () => ({
  CustomKeyModal: () => null,
  loadCustomKeys: async () => JSON.parse(state.storage.get('custom') ?? '[]'),
  saveCustomKeys: async (keys: CustomKey[]) => state.storage.set('custom', JSON.stringify(keys))
}))
vi.mock('./DragReorderList', () => ({
  DragReorderList: <T,>(props: DragReorderListProps<T>) =>
    createElement(
      hosts.View,
      {},
      props.items.map((item) =>
        createElement(hosts.View, { key: props.itemKey(item) }, props.renderRow(item))
      )
    )
}))

import { TerminalShortcutSettings } from './TerminalShortcutSettings'
import { DragReorderList } from './DragReorderList'
import { CustomKeyModal } from './CustomKeyModal'
import {
  getDefaultTerminalAccessoryBuiltInIds,
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY
} from '../terminal/terminal-accessory-layout'

const custom: CustomKey[] = [
  { id: 'model', label: 'Model', bytes: '/model fast\r', enter: false },
  { id: 'build', label: 'Build', bytes: 'pnpm build\r', enter: false }
]
const builtInIds = getDefaultTerminalAccessoryBuiltInIds()
const defaultOrder = builtInIds.map((id) => `builtin:${id}`)
const mixedOrder = ['custom:model', defaultOrder[0]!, 'custom:build', ...defaultOrder.slice(1)]

function Harness() {
  return createElement(TerminalShortcutSettings, {
    scrollRef: useAnimatedRef<Animated.ScrollView>(),
    scrollOffsetY: useSharedValue(0),
    scrollContentHeight: useSharedValue(0),
    onDragActiveChange: () => {}
  })
}

let renderer: ReactTestRenderer
async function mount() {
  await act(async () => {
    renderer = create(createElement(Harness))
  })
}
function list() {
  return renderer.root.findByType(DragReorderList)
}
function order(): string[] {
  return list().props.items.map(list().props.itemKey)
}
async function reorder(ids: string[]) {
  await act(async () => {
    list().props.onReorder(ids)
  })
}
function pressText(text: string) {
  const target = renderer.root
    .findAllByType(hosts.Pressable)
    .find((node) => node.findAllByType(hosts.Text).some((child) => child.props.children === text))
  if (!target) {
    throw new Error(`Missing ${text}`)
  }
  target.props.onPress()
}

beforeEach(() => {
  state.storage.clear()
  state.storage.set('custom', JSON.stringify(custom))
  state.storage.set(
    TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      orderedBuiltInIds: builtInIds,
      visibleBuiltInIds: builtInIds
    })
  )
  state.readLayout = null
  state.writeLayout = null
})
afterEach(() => {
  act(() => renderer?.unmount())
})

describe('terminal shortcut settings', () => {
  it('uses one list to move custom shortcuts across built-ins and restores the order on reopen', async () => {
    await mount()
    expect(renderer.root.findAllByType(DragReorderList)).toHaveLength(1)
    expect(order()).toEqual([...defaultOrder, 'custom:model', 'custom:build'])
    await reorder(mixedOrder)
    expect(order()).toEqual(mixedOrder)
    await act(async () => {
      renderer.unmount()
    })
    await mount()
    expect(order()).toEqual(mixedOrder)
  })

  it('keeps mixed positions on hide/show and resets built-ins without deleting custom shortcuts', async () => {
    await mount()
    await reorder(mixedOrder)
    await act(async () => {
      renderer.root.findAllByType(hosts.Switch)[0]!.props.onValueChange(false)
    })
    expect(order()).toEqual(mixedOrder)
    expect(renderer.root.findAllByType(hosts.Switch)[0]!.props.value).toBe(false)
    await act(async () => {
      pressText('Reset Defaults')
    })
    expect(order()).toEqual([...defaultOrder, 'custom:model', 'custom:build'])
    expect(renderer.root.findAllByType(hosts.Switch).every((node) => node.props.value)).toBe(true)
    expect(JSON.parse(state.storage.get('custom')!)).toEqual(custom)
  })

  it('deletes a mixed custom entry and appends a new shortcut without moving surviving entries', async () => {
    await mount()
    await reorder(mixedOrder)
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Delete Model' }).props.onPress()
    })
    expect(order()).toEqual(mixedOrder.filter((id) => id !== 'custom:model'))
    await act(async () => {
      renderer.root
        .findByType(CustomKeyModal)
        .props.onKeysChanged([custom[1], { id: 'new', label: 'New', bytes: 'new', enter: false }])
    })
    expect(order()).toEqual([...mixedOrder.filter((id) => id !== 'custom:model'), 'custom:new'])
    expect(JSON.parse(state.storage.get('custom')!)).toEqual([custom[1]])
  })

  it('does not let a stale focus read overwrite a reorder', async () => {
    await mount()
    const oldRaw = state.storage.get(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY)!
    let finishRead = (_value: string) => {}
    state.readLayout = () =>
      new Promise((resolve) => {
        finishRead = resolve
      })
    act(() => {
      state.refresh()
    })
    state.readLayout = null
    await reorder(mixedOrder)
    await act(async () => {
      finishRead(oldRaw)
    })
    expect(order()).toEqual(mixedOrder)
  })

  it('keeps the optimistic order when a foreground read races a queued save', async () => {
    await mount()
    let finishWrite = () => {}
    state.writeLayout = () =>
      new Promise((resolve) => {
        finishWrite = resolve
      })
    await reorder(mixedOrder)
    await act(async () => {
      state.foreground('active')
    })
    expect(order()).toEqual(mixedOrder)
    await act(async () => {
      finishWrite()
    })
    state.writeLayout = null
    await act(async () => {
      renderer.unmount()
    })
    await mount()
    expect(order()).toEqual(mixedOrder)
  })
})
