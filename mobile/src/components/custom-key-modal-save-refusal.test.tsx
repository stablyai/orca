import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  // Annotated rather than asserted: the literal alone narrows `raw` to `null`.
  const held: {
    raw: string | null
    refuse: boolean
    failRead: boolean
    writes: number
    holdWrites: Promise<void> | null
  } = { raw: null, refuse: false, failRead: false, writes: 0, holdWrites: null }
  return held
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => {
      if (store.failRead) {
        throw new Error('the store could not be read')
      }
      return store.raw
    },
    setItem: async (_key: string, value: string) => {
      await store.holdWrites
      store.writes += 1
      if (store.refuse) {
        throw new Error(
          'Orca could not save orca:custom-accessory-keys: a stored value may be too large.'
        )
      }
      store.raw = value
    }
  }
}))
// Use function-component identity instead of host strings rejected by renderer ElementType; preserve test typecheck.
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
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios }
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: hosts.View }))
vi.mock('./BottomDrawer', () => ({ BottomDrawer: hosts.View }))

import { CustomKeyModal } from './CustomKeyModal'
import { loadCustomKeys, removeCustomKey, saveCustomKeys } from '../terminal/terminal-custom-keys'
import { readMirroredStorage } from '../storage/mirrored-storage-keys'

const CUSTOM_KEYS = 'orca:custom-accessory-keys'

/** What a later `init` would carry for this key, which is the map and not the store. */
function mirrored(): string | undefined {
  return readMirroredStorage([CUSTOM_KEYS])[CUSTOM_KEYS]
}

/** The one label a node renders, flattened, without walking a fiber into a cycle. */
function labelOf(node: { props: { children?: unknown } }): string {
  const seen: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      seen.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child)
      }
    }
  }
  walk(node.props.children)
  return seen.join(' ')
}

/** Through the drawer as a user reaches it: pick the shortcut type, then press Add. */
function addAShortcut(renderer: ReturnType<typeof create>): void {
  const pressables = () => renderer.root.findAll((node) => node.type === hosts.Pressable)
  const press = (match: (label: string) => boolean, what: string): void => {
    const target = pressables().find((node) =>
      match(
        node
          .findAll((child) => child.type === hosts.Text)
          .map((child) => labelOf(child))
          .join(' ')
      )
    )
    if (target === undefined) {
      throw new Error(`the modal rendered no ${what} control`)
    }
    const onPress = target.props.onPress
    if (typeof onPress !== 'function') {
      throw new Error(`the ${what} control has no press handler`)
    }
    act(() => {
      onPress()
    })
  }
  press((label) => label.includes('Shortcut Combo'), 'shortcut-type')
  press((label) => label.trim() === 'Add', 'save')
}

beforeEach(() => {
  store.raw = null
  store.refuse = false
  store.failRead = false
  store.writes = 0
  store.holdWrites = null
})

// Page allowlisted custom keys reject over-size/unseeded writes (rulings 33.4/33.6). Modal must catch void-call rejection or page faults and drops generation.
describe('adding a custom key when the store refuses the write', () => {
  it('does not let the refusal escape as an unhandled rejection', async () => {
    store.refuse = true
    const before = mirrored()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const onKeysChanged = vi.fn()
    const onClose = vi.fn()
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(createElement(CustomKeyModal, { visible: true, onClose, onKeysChanged }))
    })
    if (renderer === null) {
      throw new Error('the modal did not render')
    }
    addAShortcut(renderer)
    // Two turns: the load settles, then the save rejects into whatever catches it.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    // Do not report unstored key as added to accessory row.
    expect(onKeysChanged).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // Restore mirror after refused save: saveCustomKeys notes map before persistence, and next init must not include rejected value.
    expect(mirrored()).toBe(before)
  })

  it('reports the key and closes when the store takes it, so the case above is the refusal', async () => {
    const onKeysChanged = vi.fn()
    const onClose = vi.fn()
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(createElement(CustomKeyModal, { visible: true, onClose, onKeysChanged }))
    })
    if (renderer === null) {
      throw new Error('the modal did not render')
    }
    addAShortcut(renderer)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onKeysChanged).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('removing a custom key', () => {
  const kept = { id: 'custom-1', label: 'Ctrl+C', bytes: '\u0003', enter: false }
  const removed = { id: 'custom-2', label: 'Ctrl+D', bytes: '\u0004', enter: false }

  it('rejects when the store refuses, so a caller never drops the row', async () => {
    store.raw = JSON.stringify([kept, removed])
    store.refuse = true
    await expect(removeCustomKey(removed.id)).rejects.toThrow()
  })

  it('answers the stored list without the key once the store takes it', async () => {
    store.raw = JSON.stringify([kept, removed])
    await expect(removeCustomKey(removed.id)).resolves.toEqual([kept])
  })

  it('lets two removals in flight together both land', async () => {
    const third = { id: 'custom-3', label: 'Ctrl+Z', bytes: '\u001a', enter: false }
    store.raw = JSON.stringify([kept, removed, third])
    await Promise.all([removeCustomKey(kept.id), removeCustomKey(removed.id)])
    expect(JSON.parse(store.raw ?? '[]')).toEqual([third])
  })

  it('removes from the list a settings save in flight stored, not the list before it', async () => {
    const third = { id: 'custom-3', label: 'Ctrl+Z', bytes: '\u001a', enter: false }
    store.raw = JSON.stringify([kept, removed, third])
    let releaseWrites: () => void = () => {}
    store.holdWrites = new Promise((resolve) => {
      releaseWrites = resolve
    })
    const reorder = saveCustomKeys([third, removed, kept])
    const removal = removeCustomKey(removed.id)
    releaseWrites()
    await Promise.all([reorder, removal])
    expect(JSON.parse(store.raw ?? '[]')).toEqual([third, kept])
  })

  it('writes nothing when the stored list cannot be read, so a read failure erases nothing', async () => {
    store.raw = JSON.stringify([kept, removed])
    store.failRead = true
    await expect(removeCustomKey(removed.id)).rejects.toThrow()
    expect(store.writes).toBe(0)
  })
})

describe('adding a custom key when the stored list cannot be read', () => {
  it('writes nothing and keeps the drawer open', async () => {
    store.failRead = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onKeysChanged = vi.fn()
    const onClose = vi.fn()
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(createElement(CustomKeyModal, { visible: true, onClose, onKeysChanged }))
    })
    if (renderer === null) {
      throw new Error('the modal did not render')
    }
    addAShortcut(renderer)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.writes).toBe(0)
    expect(onKeysChanged).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('when the stored value holds no keys', () => {
  const HOLDS_NO_KEYS = ['{not json', 'null', '{}', '[null]']

  it.each(HOLDS_NO_KEYS)('an add replaces %s with the new key', async (raw) => {
    store.raw = raw
    const onKeysChanged = vi.fn()
    const onClose = vi.fn()
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(createElement(CustomKeyModal, { visible: true, onClose, onKeysChanged }))
    })
    if (renderer === null) {
      throw new Error('the modal did not render')
    }
    addAShortcut(renderer)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(JSON.parse(store.raw ?? '[]')).toHaveLength(1)
    expect(onKeysChanged).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it.each(HOLDS_NO_KEYS)('a removal replaces %s with an empty list', async (raw) => {
    store.raw = raw
    await expect(removeCustomKey('custom-1')).resolves.toEqual([])
    expect(store.raw).toBe('[]')
  })

  it.each(HOLDS_NO_KEYS)('loading %s shows no keys', async (raw) => {
    store.raw = raw
    await expect(loadCustomKeys()).resolves.toEqual([])
  })
})
