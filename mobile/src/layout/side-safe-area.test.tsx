import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { EdgeInsets, Rect } from 'react-native-safe-area-context'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
// The library's hooks are plain reads of its two contexts, which is all this stands in for.
vi.mock('react-native-safe-area-context', async () => {
  const { createContext, useContext } = await import('react')
  const SafeAreaInsetsContext = createContext<EdgeInsets | null>(null)
  const SafeAreaFrameContext = createContext<Rect | null>(null)
  return {
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
    useSafeAreaInsets: () => useContext(SafeAreaInsetsContext),
    useSafeAreaFrame: () => useContext(SafeAreaFrameContext)
  }
})

const { SafeAreaFrameContext, SafeAreaInsetsContext, useSafeAreaFrame, useSafeAreaInsets } =
  await import('react-native-safe-area-context')
const { SideSafeArea, useWindowSafeAreaInsets } = await import('./side-safe-area')

// Unequal sides, so a swapped edge shows.
const WINDOW = { top: 0, right: 48, bottom: 21, left: 59 }
const FRAME = { x: 0, y: 0, width: 852, height: 393 }

function renderInLandscape() {
  const read: { screen?: EdgeInsets; frame?: Rect; modal?: EdgeInsets } = {}
  function Probe() {
    read.screen = useSafeAreaInsets()
    read.frame = useSafeAreaFrame()
    read.modal = useWindowSafeAreaInsets()
    return null
  }
  let tree: ReactTestRenderer | undefined
  act(() => {
    tree = create(
      <SafeAreaFrameContext.Provider value={FRAME}>
        <SafeAreaInsetsContext.Provider value={WINDOW}>
          <SideSafeArea>
            <Probe />
          </SideSafeArea>
        </SafeAreaInsetsContext.Provider>
      </SafeAreaFrameContext.Provider>
    )
  })
  return { tree: tree!, read }
}

describe('the app laid out clear of the side insets', () => {
  it('pads the sides once, and screens below see the padded area', () => {
    const { tree, read } = renderInLandscape()
    const area = tree.root.find((node) => String(node.type) === 'View')
    expect(Object.assign({}, ...[area.props.style].flat())).toMatchObject({
      paddingLeft: 59,
      paddingRight: 48
    })
    expect(read.screen).toEqual({ top: 0, right: 0, bottom: 21, left: 0 })
    expect(read.frame).toEqual({ x: 59, y: 0, width: 745, height: 393 })
  })

  it('gives a Modal, which opens a window of its own, the window insets', () => {
    expect(renderInLandscape().read.modal).toEqual(WINDOW)
  })
})

afterEach(unmountRenderers)
