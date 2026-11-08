import { useState } from 'react'
import { Pressable, Text } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} }
}))
vi.mock('../../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => false }))
vi.mock('./mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'MountedBottomDrawer' }))
vi.mock('react-native-reanimated', async () => {
  const React = await import('react')
  const { reanimatedPagerStub } = await import('../../test-support/reanimated-pager-stub')
  return {
    ...reanimatedPagerStub(),
    // Shared values outlive the drawer's content, just as they do in Reanimated.
    useSharedValue: (initial: number) => React.useRef({ value: initial }).current,
    useAnimatedStyle: (style: () => object) => style()
  }
})

import { BottomDrawer, OptionPager, useOptionPager } from './BottomDrawer'
import { MountedBottomDrawer } from './mounted-bottom-drawer'

function Sheet() {
  const [visible, setVisible] = useState(false)
  const pager = useOptionPager<'sortBy'>()
  return (
    <>
      <Pressable accessibilityLabel="Workspace options" onPress={() => setVisible(true)} />
      <BottomDrawer visible={visible} onClose={() => setVisible(false)} onAfterClose={pager.forget}>
        <Pressable accessibilityLabel="Done" onPress={() => setVisible(false)} />
        <OptionPager
          pager={pager}
          main={<Pressable accessibilityLabel="Sort by" onPress={() => pager.open('sortBy')} />}
          page={
            pager.page === null ? null : (
              <Pressable accessibilityLabel="Back" onPress={pager.close}>
                <Text>Recent</Text>
              </Pressable>
            )
          }
        />
      </BottomDrawer>
    </>
  )
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function press(label: string) {
  act(() => {
    renderer!.root
      .find((node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label)
      .props.onPress()
  })
}

function layout(width: number) {
  act(() => {
    renderer!.root
      .find((node) => String(node.type) === 'View' && node.props.onLayout)
      .props.onLayout({ nativeEvent: { layout: { width } } })
  })
}

const drawer = () => renderer!.root.findByType(MountedBottomDrawer)
const main = () =>
  renderer!.root.find((node) => String(node.type) === 'AnimatedView' && 'aria-hidden' in node.props)
const mainOffset = () => main().props.style.at(-1).transform[0].translateX

function open() {
  press('Workspace options')
  layout(600)
}

describe('a drawer option pager', () => {
  it('reopens at the root with full-width content after Done from a sub-page', () => {
    act(() => {
      renderer = create(<Sheet />)
    })
    open()
    expect(mainOffset()).toBeCloseTo(0)
    press('Sort by')
    expect(mainOffset()).toBeLessThan(0)

    press('Done')
    expect(drawer().props.visible).toBe(false)
    expect(main().props['aria-hidden']).toBe(true)
    // Native hide completes before KeyedBottomDrawer unmounts content and forgets its page.
    act(() => drawer().props.onHidden())
    expect(renderer!.root.findAllByType(MountedBottomDrawer)).toHaveLength(0)

    open()
    expect(main().props['aria-hidden']).toBe(false)
    expect(mainOffset()).toBeCloseTo(0)
    layout(390)
    expect(mainOffset()).toBeCloseTo(0)
  })

  it('still pushes a sub-page and returns to the root with Back', () => {
    act(() => {
      renderer = create(<Sheet />)
    })
    open()
    press('Sort by')
    expect(main().props['aria-hidden']).toBe(true)
    expect(mainOffset()).toBeLessThan(0)
    press('Back')
    expect(drawer().props.visible).toBe(true)
    expect(main().props['aria-hidden']).toBe(false)
    expect(mainOffset()).toBeCloseTo(0)
  })
})
