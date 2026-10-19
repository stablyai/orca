import { createElement, useEffect, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomKey } from './CustomKeyModal'

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
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  Switch: hosts.View,
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios }
}))
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
  const held: { custom: { items: CustomKey[]; onReorder: (ids: string[]) => void } | null } = {
    custom: null
  }
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

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(
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
  store.values = new Map([[CUSTOM_KEYS, JSON.stringify(keys)]])
  store.holdWrites = null
  store.refuseWrites = false
  lists.custom = null
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
