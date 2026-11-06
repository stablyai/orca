import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ReleasedSideInsetContext, type ReleasedSideInset } from '../layout/released-side-inset'
import { useChatBottomFit } from './native-chat/composer/use-chat-bottom-fit'
import { applyStoredDuoChatExpanded } from './duo-chat-width'

const store = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: async (key: string) => {
      store.delete(key)
    },
    multiGet: async (keys: readonly string[]) => keys.map((key) => [key, store.get(key) ?? null])
  }
}))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => true }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 })
}))

const COVER: ReleasedSideInset = { side: 'right', width: 84 }
const INNER: ReleasedSideInset = { side: 'right', width: 84 }
const TURNED: ReleasedSideInset = { side: 'left', width: 84 }

type Fit = ReturnType<typeof useChatBottomFit>
let tree: ReactTestRenderer | undefined
const seen: { cover?: Fit; inner?: Fit; turned?: Fit; phone?: Fit } = {}

afterEach(() => {
  store.clear()
  act(() => {
    applyStoredDuoChatExpanded(null)
    tree?.unmount()
  })
  tree = undefined
  seen.cover = undefined
  seen.inner = undefined
  seen.turned = undefined
  seen.phone = undefined
})

function Probe({ name, keyboard = 0 }: { name: keyof typeof seen; keyboard?: number }): null {
  seen[name] = useChatBottomFit(keyboard)
  return null
}

function posture(name: keyof typeof seen, inset: ReleasedSideInset | null, keyboard = 0) {
  return createElement(
    ReleasedSideInsetContext.Provider,
    { value: inset },
    createElement(Probe, { name, keyboard })
  )
}

it('uses one expanded chat on the folded cover and the unfolded inner display', async () => {
  await act(async () => {
    tree = create(
      createElement(
        Fragment,
        null,
        posture('cover', COVER),
        posture('inner', INNER),
        posture('turned', TURNED),
        posture('phone', null)
      )
    )
    await Promise.resolve()
  })

  expect(seen.cover?.composerFit.widthToggle?.expanded).toBe(true)
  expect(seen.inner?.composerFit.widthToggle?.expanded).toBe(true)
  expect(seen.turned?.composerFit.widthToggle?.expanded).toBe(true)
  expect(seen.cover?.transcriptInset).toBeNull()
  expect(seen.inner?.transcriptInset).toBeNull()
  expect(seen.turned?.transcriptInset).toBeNull()
  expect(seen.phone?.composerFit.widthToggle).toBeNull()

  await act(async () => {
    seen.cover?.composerFit.widthToggle?.onToggle()
  })

  expect(seen.cover?.composerFit.widthToggle?.expanded).toBe(false)
  expect(seen.inner?.composerFit.widthToggle?.expanded).toBe(false)
  expect(seen.turned?.composerFit.widthToggle?.expanded).toBe(false)
  expect(seen.cover?.transcriptInset).toEqual({ marginRight: 84 })
  expect(seen.inner?.transcriptInset).toEqual({ marginRight: 84 })
  expect(seen.turned?.transcriptInset).toEqual({ marginLeft: 84 })
  expect(seen.phone?.transcriptInset).toBeNull()
})

it('keeps the width toggle while the keyboard is up on both Duo postures', async () => {
  await act(async () => {
    tree = create(
      createElement(Fragment, null, posture('cover', COVER, 120), posture('inner', INNER, 120))
    )
    await Promise.resolve()
  })

  expect(seen.cover?.composerFit.widthToggle?.expanded).toBe(true)
  expect(seen.inner?.composerFit.widthToggle?.expanded).toBe(true)
  expect(seen.cover?.composerFit.fitScreenCorners).toBe(false)
  expect(seen.inner?.composerFit.fitScreenCorners).toBe(false)
})
