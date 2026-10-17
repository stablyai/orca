// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import type { CustomKey } from './CustomKeyModal'
import type { TerminalAccessoryLayoutPreference } from '../terminal/terminal-accessory-layout'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const mocks = vi.hoisted(() => {
  const held: {
    loadLayoutQueue: Array<Promise<TerminalAccessoryLayoutPreference>>
    loadCustomQueue: Array<Promise<CustomKey[]>>
    saveLayout: ReturnType<typeof vi.fn<(_layout: unknown) => Promise<void>>>
    saveCustom: ReturnType<typeof vi.fn<(_keys: CustomKey[]) => Promise<void>>>
    focusEffectCb: (() => void) | null
  } = {
    loadLayoutQueue: [],
    loadCustomQueue: [],
    saveLayout: vi.fn<(_layout: unknown) => Promise<void>>(async () => {}),
    saveCustom: vi.fn<(_keys: CustomKey[]) => Promise<void>>(async () => {}),
    focusEffectCb: null
  }
  return held
})

const hosts = vi.hoisted(() => {
  const make = (name: string) => {
    const Host = (props: { children?: ReactNode }): ReactNode => props.children ?? null
    Host.displayName = name
    return Host
  }
  const DragReorderList = (props: {
    items?: unknown[]
    renderRow?: (item: unknown, index: number) => ReactNode
  }): ReactNode => (props.items && props.renderRow ? props.items.map(props.renderRow) : null)
  DragReorderList.displayName = 'DragReorderList'
  return {
    View: make('View'),
    Text: make('Text'),
    Pressable: make('Pressable'),
    Switch: make('Switch'),
    DragReorderList,
    CustomKeyModal: make('CustomKeyModal')
  }
})

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  Switch: hosts.Switch,
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))

vi.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => {
    mocks.focusEffectCb = cb
  }
}))

vi.mock('lucide-react-native', () => ({
  ChevronRight: hosts.View,
  Minus: hosts.View,
  Plus: hosts.View,
  X: hosts.View
}))

vi.mock('./DragReorderList', () => ({
  DragReorderList: hosts.DragReorderList
}))

vi.mock('./CustomKeyModal', () => ({
  CustomKeyModal: hosts.CustomKeyModal,
  loadCustomKeys: () => mocks.loadCustomQueue.shift() ?? Promise.resolve([]),
  saveCustomKeys: (keys: CustomKey[]) => mocks.saveCustom(keys)
}))

vi.mock('../terminal/terminal-accessory-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal/terminal-accessory-layout')>()
  return {
    ...actual,
    loadTerminalAccessoryLayout: () =>
      mocks.loadLayoutQueue.shift() ??
      Promise.resolve(
        actual.createTerminalAccessoryLayoutPreference(actual.getDefaultTerminalAccessoryLayout())
      ),
    saveTerminalAccessoryLayout: (layout: unknown) => mocks.saveLayout(layout)
  }
})

import { TerminalShortcutSettings } from './TerminalShortcutSettings'
import {
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryBuiltInIds
} from '../terminal/terminal-accessory-layout'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DragReorderList is mocked and never invokes scrollRef.
const dummyScrollRef = (() => null) as unknown as AnimatedRef<Animated.ScrollView>
const dummySharedValue: SharedValue<number> = {
  value: 0,
  get: () => 0,
  set: () => {},
  addListener: () => {},
  removeListener: () => {},
  modify: () => {}
}

describe('TerminalShortcutSettings refresh gating', () => {
  beforeEach(() => {
    mocks.loadLayoutQueue.length = 0
    mocks.loadCustomQueue.length = 0
    mocks.saveLayout.mockClear()
    mocks.saveCustom.mockClear()
    mocks.focusEffectCb = null
  })

  it('disables edits until both refreshes settle and discards stale refresh results', async () => {
    const builtIns = getDefaultTerminalAccessoryBuiltInIds()
    const staleCustomKey: CustomKey = {
      id: 'custom-stale',
      label: 'Old',
      bytes: 'pwd\r',
      enter: true
    }
    const freshCustomKey: CustomKey = { id: 'custom-1', label: 'C1', bytes: 'ls\r', enter: true }
    const staleLayout = createTerminalAccessoryLayoutPreference({
      rowCount: 1,
      rows: [[...builtIns, 'custom-stale']],
      orderedBuiltInIds: builtIns,
      visibleBuiltInIds: builtIns
    })
    const freshLayout = createTerminalAccessoryLayoutPreference({
      rowCount: 2,
      rows: [builtIns, ['custom-1']],
      orderedBuiltInIds: builtIns,
      visibleBuiltInIds: builtIns
    })

    const layout1 = createDeferred<TerminalAccessoryLayoutPreference>()
    const custom1 = createDeferred<CustomKey[]>()
    const layout2 = createDeferred<TerminalAccessoryLayoutPreference>()
    const custom2 = createDeferred<CustomKey[]>()
    mocks.loadLayoutQueue.push(layout1.promise, layout2.promise)
    mocks.loadCustomQueue.push(custom1.promise, custom2.promise)

    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(
        createElement(TerminalShortcutSettings, {
          scrollRef: dummyScrollRef,
          scrollOffsetY: dummySharedValue,
          scrollContentHeight: dummySharedValue,
          onDragActiveChange: () => {}
        })
      )
    })
    act(() => {
      mocks.focusEffectCb?.()
    })

    // Layout resolves first while custom keys are still loading.
    await act(async () => {
      layout1.resolve(staleLayout)
      await layout1.promise
    })

    const dragListWhileHalfLoaded = renderer.root.findByType(hosts.DragReorderList)
    expect(dragListWhileHalfLoaded.props.isItemDraggable({ kind: 'built-in', id: 'esc' })).toBe(
      false
    )

    // Attempted reorder or switch toggle while custom keys are still loading must not persist.
    act(() => {
      dragListWhileHalfLoaded.props.onReorder(builtIns)
      const firstSwitch = renderer.root.findAllByType(hosts.Switch)[0]!
      firstSwitch.props.onValueChange(false)
    })
    expect(mocks.saveLayout).not.toHaveBeenCalled()

    // Start an overlapping second refresh before custom1 settles, and resolve the newer refresh first.
    act(() => {
      mocks.focusEffectCb?.()
    })

    await act(async () => {
      layout2.resolve(freshLayout)
      custom2.resolve([freshCustomKey])
      await Promise.all([layout2.promise, custom2.promise])
    })

    // Newer refresh settled, but custom1 from the older refresh is still in flight.
    const dragListDuringOverlap = renderer.root.findByType(hosts.DragReorderList)
    expect(dragListDuringOverlap.props.isItemDraggable({ kind: 'built-in', id: 'esc' })).toBe(false)

    // Resolve the older custom1 last; its stale value must be discarded in favor of custom2.
    await act(async () => {
      custom1.resolve([staleCustomKey])
      await custom1.promise
    })

    const dragListAfterReady = renderer.root.findByType(hosts.DragReorderList)
    expect(dragListAfterReady.props.isItemDraggable({ kind: 'built-in', id: 'esc' })).toBe(true)

    // Now an edit persists the fresh layout (2 rows with custom-1 in Row 2, not custom-stale).
    act(() => {
      const firstSwitch = renderer.root.findAllByType(hosts.Switch)[0]!
      firstSwitch.props.onValueChange(false)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.saveLayout).toHaveBeenCalledTimes(1)
    expect(mocks.saveLayout.mock.calls[0]?.[0]).toMatchObject({
      rowCount: 2,
      rows: [builtIns, ['custom-1']]
    })
  })
})

describe('TerminalShortcutSettings custom key editing', () => {
  beforeEach(() => {
    mocks.loadLayoutQueue.length = 0
    mocks.loadCustomQueue.length = 0
    mocks.saveLayout.mockClear()
    mocks.saveCustom.mockClear()
    mocks.focusEffectCb = null
  })

  async function renderReady(customKey: CustomKey): Promise<ReturnType<typeof create>> {
    mocks.loadCustomQueue.push(Promise.resolve([customKey]))
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(
        createElement(TerminalShortcutSettings, {
          scrollRef: dummyScrollRef,
          scrollOffsetY: dummySharedValue,
          scrollContentHeight: dummySharedValue,
          onDragActiveChange: () => {}
        })
      )
    })
    act(() => {
      mocks.focusEffectCb?.()
    })
    await act(async () => {
      for (let step = 0; step < 6; step += 1) {
        await Promise.resolve()
      }
    })
    return renderer
  }

  it('opens the editor for a custom row and clears it on close without deleting', async () => {
    const customKey: CustomKey = {
      id: 'custom-1',
      label: 'Build',
      bytes: 'pnpm build\r',
      enter: true
    }
    const renderer = await renderReady(customKey)
    const edit = renderer.root
      .findAllByType(hosts.Pressable)
      .find((node) => node.props.accessibilityLabel === 'Edit Build')
    const remove = renderer.root
      .findAllByType(hosts.Pressable)
      .find((node) => node.props.accessibilityLabel === 'Delete Build')
    expect(edit).toBeDefined()
    expect(remove).toBeDefined()
    expect(edit?.props.disabled).toBe(false)

    act(() => {
      edit?.props.onPress()
    })
    const modal = renderer.root.findByType(hosts.CustomKeyModal)
    expect(modal.props.visible).toBe(true)
    expect(modal.props.editingKey).toEqual(customKey)

    act(() => {
      modal.props.onClose()
    })
    const closed = renderer.root.findByType(hosts.CustomKeyModal)
    expect(closed.props.visible).toBe(false)
    expect(closed.props.editingKey).toBeNull()
    expect(mocks.saveCustom).not.toHaveBeenCalled()

    await act(async () => {
      remove?.props.onPress()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.saveCustom).toHaveBeenCalledTimes(1)
    expect(mocks.saveCustom.mock.calls[0]?.[0]).toEqual([])
    expect(renderer.root.findByType(hosts.CustomKeyModal).props.visible).toBe(false)
  })
})
