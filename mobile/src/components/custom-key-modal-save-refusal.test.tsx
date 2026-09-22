import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  // Annotated rather than asserted: the literal alone narrows `raw` to `null`.
  const held: { raw: string | null; refuse: boolean } = { raw: null, refuse: false }
  return held
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => store.raw,
    setItem: async () => {
      if (store.refuse) {
        throw new Error(
          'Orca could not save orca:custom-accessory-keys: a stored value may be too large.'
        )
      }
    }
  }
}))
/**
 * Function components rather than host strings, so a case can match a node by identity: the
 * renderer types `node.type` as an `ElementType`, which a string literal is not, and the tests
 * ratchet checks this file.
 */
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
})

/**
 * The page refuses a write the app would have taken, and the modal is one of its callers.
 *
 * `orca:custom-accessory-keys` is in the session route's page allowlist, and on the page a write
 * over `PAGE_STORAGE_MAX_VALUE_CHARS` rejects rather than dropping — that is the size contract of
 * ruling 33.4, and ruling 33.6 adds the key `init` could not carry at all. Every other allowlisted
 * writer in this closure catches its save; this one awaited it inside a `void` call, so the
 * rejection had nowhere to go but the page's unhandled-rejection handler, which reports a page
 * fault and drops the generation.
 */
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
    // And the modal does not report a key it failed to store: a row that looks added and is not
    // is the failure the allowlist exists to avoid.
    expect(onKeysChanged).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // And the mirror is back where it started. `saveCustomKeys` notes the write before it
    // persists, because a reader is answered from the map; a refused write that left the note
    // standing would put the key the store rejected into the next `init`.
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
