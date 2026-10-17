import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTerminalShortcutKey } from '../terminal/terminal-accessory-keys'
import type { CustomKey } from './CustomKeyModal'

const store = vi.hoisted(() => ({ raw: null as string | null }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => store.raw,
    setItem: async (_key: string, value: string) => {
      store.raw = value
    }
  }
}))

const hosts = vi.hoisted(() => {
  const make = (name: string) => {
    const Host = (props: { children?: ReactNode }): ReactNode => props.children ?? null
    Host.displayName = name
    return Host
  }
  return {
    View: make('View'),
    Text: make('Text'),
    Pressable: make('Pressable'),
    TextInput: make('TextInput'),
    Switch: make('Switch')
  }
})

vi.mock('react-native', () => ({
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  TextInput: hosts.TextInput,
  Switch: hosts.Switch,
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios }
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: hosts.View }))
vi.mock('./BottomDrawer', () => ({ BottomDrawer: hosts.View }))

import { CustomKeyModal } from './CustomKeyModal'

type Renderer = ReturnType<typeof create>

function labelOf(node: { props: { children?: unknown } }): string {
  const seen: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') {
      seen.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child)
      }
    }
  }
  walk(node.props.children)
  return seen.join('')
}

function pressableLabel(node: {
  findAll: (predicate: (child: { type: unknown }) => boolean) => { props: { children?: unknown } }[]
}): string {
  return node
    .findAll((child) => child.type === hosts.Text)
    .map((child) => labelOf(child))
    .join('')
}

function texts(renderer: Renderer): string[] {
  return renderer.root.findAllByType(hosts.Text).map((node) => labelOf(node))
}

function pressMatching(renderer: Renderer, match: (label: string) => boolean, what: string): void {
  const target = renderer.root
    .findAllByType(hosts.Pressable)
    .find((node) => match(pressableLabel(node)))
  if (!target || typeof target.props.onPress !== 'function') {
    throw new Error(`missing pressable ${what}`)
  }
  act(() => {
    target.props.onPress()
  })
}

async function flushSave(): Promise<void> {
  await act(async () => {
    for (let step = 0; step < 8; step += 1) {
      await Promise.resolve()
    }
  })
}

const macro: CustomKey = { id: 'custom-edit', label: 'Build', bytes: 'pnpm build\r', enter: false }
const neighbor: CustomKey = { id: 'custom-keep', label: 'Stay', bytes: 'stay', enter: false }
const tail: CustomKey = { id: 'custom-tail', label: 'Tail', bytes: 'tail', enter: false }

beforeEach(() => {
  store.raw = JSON.stringify([neighbor, macro, tail])
})

describe('CustomKeyModal editing', () => {
  it('opens a text macro on its form and saves over the same id in place', async () => {
    const onKeysChanged = vi.fn()
    const onClose = vi.fn()
    let renderer!: Renderer
    act(() => {
      renderer = create(
        createElement(CustomKeyModal, {
          visible: true,
          editingKey: macro,
          onClose,
          onKeysChanged
        })
      )
    })

    expect(texts(renderer)).toContain('Edit Shortcut')
    expect(texts(renderer)).not.toContain('Add Shortcut')
    const inputs = renderer.root.findAllByType(hosts.TextInput)
    expect(inputs.map((input) => input.props.value)).toEqual(['Build', 'pnpm build'])
    expect(renderer.root.findByType(hosts.Switch).props.value).toBe(true)

    act(() => {
      inputs[1]?.props.onChangeText('pnpm test')
    })
    pressMatching(renderer, (label) => label.trim() === 'Save Changes', 'save')
    await flushSave()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onKeysChanged).toHaveBeenCalledTimes(1)
    const saved = onKeysChanged.mock.calls[0]?.[0] as CustomKey[]
    expect(saved.map((key) => key.id)).toEqual(['custom-keep', 'custom-edit', 'custom-tail'])
    expect(saved[1]).toEqual({
      id: 'custom-edit',
      label: 'Build',
      bytes: 'pnpm test\r',
      enter: false
    })
  })

  it('opens a shortcut combo with its modifiers and keeps the id', async () => {
    const built = buildTerminalShortcutKey({ key: 'arrowUp', modifiers: ['ctrl', 'alt'] })
    if (!built) {
      throw new Error('arrow chord did not build')
    }
    const chord: CustomKey = {
      id: 'custom-chord',
      label: built.label,
      bytes: built.bytes,
      enter: false
    }
    store.raw = JSON.stringify([chord])
    const onKeysChanged = vi.fn()
    let renderer!: Renderer
    act(() => {
      renderer = create(
        createElement(CustomKeyModal, {
          visible: true,
          editingKey: chord,
          onClose: vi.fn(),
          onKeysChanged
        })
      )
    })

    expect(texts(renderer)).toContain('Edit Shortcut')
    const selected = renderer.root
      .findAllByType(hosts.Pressable)
      .filter((node) => node.props.accessibilityState?.selected === true)
      .map((node) => pressableLabel(node))
    expect(selected.some((label) => label.includes('Ctrl'))).toBe(true)
    expect(selected.some((label) => label.includes('Alt'))).toBe(true)
    expect(selected.some((label) => label.includes('Shift'))).toBe(false)
    const keyInput = renderer.root.findByType(hosts.TextInput)
    expect(keyInput.props.value).toBe('')
    expect(keyInput.props.placeholder).toBe('↑')

    pressMatching(renderer, (label) => label.trim() === 'Save Changes', 'save')
    await flushSave()

    const saved = onKeysChanged.mock.calls[0]?.[0] as CustomKey[]
    expect(saved).toEqual([chord])
  })

  it('returns to the add flow after an edit is closed', () => {
    const onClose = vi.fn()
    const onKeysChanged = vi.fn()
    let renderer!: Renderer
    act(() => {
      renderer = create(
        createElement(CustomKeyModal, { visible: false, editingKey: null, onClose, onKeysChanged })
      )
    })
    act(() => {
      renderer.update(
        createElement(CustomKeyModal, {
          visible: true,
          editingKey: macro,
          onClose,
          onKeysChanged
        })
      )
    })
    expect(texts(renderer)).toContain('Edit Shortcut')
    act(() => {
      renderer.update(
        createElement(CustomKeyModal, { visible: false, editingKey: null, onClose, onKeysChanged })
      )
    })
    act(() => {
      renderer.update(
        createElement(CustomKeyModal, { visible: true, editingKey: null, onClose, onKeysChanged })
      )
    })
    expect(texts(renderer)).toContain('Add Shortcut')
    expect(texts(renderer)).not.toContain('Edit Shortcut')
  })

  it('appends a new id when adding beside an existing key', async () => {
    store.raw = JSON.stringify([neighbor])
    const onKeysChanged = vi.fn()
    let renderer!: Renderer
    act(() => {
      renderer = create(
        createElement(CustomKeyModal, {
          visible: true,
          onClose: vi.fn(),
          onKeysChanged
        })
      )
    })
    pressMatching(renderer, (label) => label.includes('Shortcut Combo'), 'shortcut-type')
    pressMatching(renderer, (label) => label.trim() === 'Add', 'save')
    await flushSave()
    const saved = onKeysChanged.mock.calls[0]?.[0] as CustomKey[]
    expect(saved[0]?.id).toBe('custom-keep')
    expect(saved).toHaveLength(2)
    expect(saved[1]?.id.startsWith('custom-')).toBe(true)
    expect(saved[1]?.id).not.toBe('custom-keep')
  })
})
