import { createElement, type ReactElement } from 'react'
import { Pressable } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DUO_RAIL_CONTROL_SIZE,
  DUO_STATUS_GLYPH_FROM_EDGE,
  DUO_STATUS_GLYPH_SIZE
} from '../layout/duo-status-row'
import { getSideRailStrip } from '../layout/side-rail-strip'
import { spacing } from '../theme/mobile-theme'
import { DuoRailBackButton } from './DuoRailBackButton'
import { duoRailBackVisible, performSessionRailBack } from './duo-rail-back'
import { useSessionRailBack } from './use-duo-rail-back.web'

const scene = vi.hoisted(() => ({
  width: 951,
  height: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }],
  expanded: false,
  keyboardInset: 0,
  pressBack: null as (() => boolean) | null
}))

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: scene.width, height: scene.height })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft' }))
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => scene.insets
}))
vi.mock('../layout/reserved-regions', () => ({
  useReservedRegions: () => ({ divisions: [], occlusions: scene.occlusions })
}))
vi.mock('./duo-chat-width', () => ({
  useDuoChatExpanded: () => scene.expanded
}))
vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClientIfPresent: () =>
    scene.pressBack === null ? null : { pressBack: scene.pressBack }
}))

const RIGHT_RAIL = {
  windowWidth: 951,
  windowHeight: 669,
  insets: { top: 0, right: 84, bottom: 34, left: 0 },
  occlusions: [{ x: 867, y: 0, width: 84, height: 124 }]
}

function resetScene(): void {
  scene.width = RIGHT_RAIL.windowWidth
  scene.height = RIGHT_RAIL.windowHeight
  scene.insets = { ...RIGHT_RAIL.insets }
  scene.occlusions = RIGHT_RAIL.occlusions.map((region) => ({ ...region }))
  scene.expanded = false
  scene.keyboardInset = 0
  scene.pressBack = null
}

function railButton(chatVisible: boolean, onBack: () => void): ReactElement {
  return createElement(DuoRailBackButton, {
    chatVisible,
    keyboardInset: scene.keyboardInset,
    onBack
  })
}

function mount(element: ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(element)
  })
  if (renderer === undefined) {
    throw new Error('renderer did not mount')
  }
  return renderer
}

function hostNamed(type: unknown, name: string): boolean {
  return typeof type === 'string' && type === name
}

function backs(root: ReactTestRenderer) {
  return root.root.findAll(
    (node) =>
      hostNamed(node.type, 'Pressable') && node.props.accessibilityLabel === 'Back to worktrees'
  )
}

function railSlot(root: ReactTestRenderer) {
  return backs(root)[0]?.parent?.parent
}

function PageProbe({ nativeBack }: { nativeBack: () => void }) {
  const onBack = useSessionRailBack(nativeBack)
  return createElement(Pressable, { accessibilityLabel: 'probe', onPress: onBack })
}

describe('the Duo rail back button', () => {
  beforeEach(resetScene)

  it('shows only while chat is collapsed beside a status column', () => {
    const strip = getSideRailStrip(RIGHT_RAIL)
    const shown = { chatVisible: true, expanded: false, strip, keyboardInset: 0 }
    expect(duoRailBackVisible(shown)).toBe(true)
    expect(duoRailBackVisible({ ...shown, expanded: true })).toBe(false)
    expect(duoRailBackVisible({ ...shown, chatVisible: false })).toBe(false)
    expect(duoRailBackVisible({ ...shown, strip: null })).toBe(false)
    expect(duoRailBackVisible({ ...shown, keyboardInset: 312 })).toBe(false)

    const onBack = vi.fn()
    const collapsed = mount(railButton(true, onBack))
    const button = backs(collapsed)
    expect(button).toHaveLength(1)
    const column = RIGHT_RAIL.occlusions[0]!
    expect(railSlot(collapsed)?.props.style).toMatchObject({
      top: column.y + column.height + spacing.sm,
      left:
        RIGHT_RAIL.windowWidth -
        (DUO_STATUS_GLYPH_FROM_EDGE + DUO_STATUS_GLYPH_SIZE / 2) -
        DUO_RAIL_CONTROL_SIZE / 2,
      width: DUO_RAIL_CONTROL_SIZE,
      height: DUO_RAIL_CONTROL_SIZE
    })
    expect(button[0]?.props.hitSlop).toBe(0)
    const drawn = [button[0]?.props.style({ pressed: false })].flat()
    expect(Object.assign({}, ...drawn)).toMatchObject({
      width: DUO_RAIL_CONTROL_SIZE,
      height: DUO_RAIL_CONTROL_SIZE
    })
    expect(
      collapsed.root.findAll((node) => hostNamed(node.type, 'ChevronLeft'))[0]?.props.size
    ).toBe(DUO_RAIL_CONTROL_SIZE / 2)
    act(() => {
      button[0]?.props.onPress()
    })
    expect(onBack).toHaveBeenCalledTimes(1)

    scene.expanded = true
    expect(
      backs(mount(railButton(true, onBack)))
    ).toHaveLength(0)

    scene.expanded = false
    scene.insets = { top: 0, right: 0, bottom: 34, left: 0 }
    scene.occlusions = []
    expect(backs(mount(railButton(true, onBack)))).toHaveLength(0)

    resetScene()
    expect(backs(mount(railButton(false, onBack)))).toHaveLength(0)
  })

  it('follows the rail to the left and keeps the header chevron', () => {
    scene.insets = { top: 0, right: 0, bottom: 34, left: 84 }
    const occlusion = { x: 0, y: 545, width: 84, height: 124 }
    scene.occlusions = [occlusion]
    const left = mount(railButton(true, vi.fn()))
    expect(railSlot(left)?.props.style).toMatchObject({
      left: DUO_STATUS_GLYPH_FROM_EDGE + DUO_STATUS_GLYPH_SIZE / 2 - DUO_RAIL_CONTROL_SIZE / 2,
      width: DUO_RAIL_CONTROL_SIZE,
      top: occlusion.y - spacing.sm - DUO_RAIL_CONTROL_SIZE
    })
    expect(left.root.findAll((node) => hostNamed(node.type, 'ChevronLeft'))).toHaveLength(1)
  })

  it('sits below the cover status occlusion instead of under the camera', () => {
    const glyph = { x: 399.67, y: 29.33, width: 37, height: 37 }
    const column = { x: 382, y: 0, width: 84, height: 174 }
    scene.width = 466
    scene.height = 678
    scene.insets = { top: 0, right: 84, bottom: 34, left: 0 }
    scene.occlusions = [glyph, column]
    const cover = mount(railButton(true, vi.fn()))
    const slot = railSlot(cover)?.props.style
    expect(slot).toMatchObject({
      top: column.y + column.height + spacing.sm,
      left: glyph.x + glyph.width / 2 - DUO_RAIL_CONTROL_SIZE / 2,
      width: DUO_RAIL_CONTROL_SIZE,
      height: DUO_RAIL_CONTROL_SIZE
    })
    expect(slot.left + slot.width / 2).toBe(glyph.x + glyph.width / 2)
    const misses = (region: { x: number; y: number; width: number; height: number }) =>
      slot.left + slot.width <= region.x ||
      slot.left >= region.x + region.width ||
      slot.top + slot.height <= region.y ||
      slot.top >= region.y + region.height
    expect(slot.left).toBeGreaterThanOrEqual(column.x)
    expect(slot.left + slot.width).toBeLessThanOrEqual(column.x + column.width)
    expect(misses(column)).toBe(true)
    expect(misses(glyph)).toBe(true)
  })

  it('hides while the keyboard is up and returns when it closes', () => {
    scene.keyboardInset = 320
    expect(backs(mount(railButton(true, vi.fn())))).toHaveLength(0)
    scene.keyboardInset = 0
    expect(backs(mount(railButton(true, vi.fn())))).toHaveLength(1)
  })

  it('presses through the page Back claim, and the session back when the page cannot', () => {
    const nativeBack = vi.fn()
    const pageBack = vi.fn(() => true)
    performSessionRailBack(pageBack, nativeBack)
    expect(pageBack).toHaveBeenCalledTimes(1)
    expect(nativeBack).not.toHaveBeenCalled()
    performSessionRailBack(() => false, nativeBack)
    performSessionRailBack(null, nativeBack)
    expect(nativeBack).toHaveBeenCalledTimes(2)

    const took = vi.fn()
    scene.pressBack = vi.fn(() => true)
    const claimed = mount(createElement(PageProbe, { nativeBack: took }))
    act(() => {
      claimed.root.findByProps({ accessibilityLabel: 'probe' }).props.onPress()
    })
    expect(scene.pressBack).toHaveBeenCalledTimes(1)
    expect(took).not.toHaveBeenCalled()

    scene.pressBack = vi.fn(() => false)
    const missed = mount(createElement(PageProbe, { nativeBack: took }))
    act(() => {
      missed.root.findByProps({ accessibilityLabel: 'probe' }).props.onPress()
    })
    expect(took).toHaveBeenCalledTimes(1)

    scene.pressBack = null
    const native = mount(createElement(PageProbe, { nativeBack: took }))
    act(() => {
      native.root.findByProps({ accessibilityLabel: 'probe' }).props.onPress()
    })
    expect(took).toHaveBeenCalledTimes(2)
  })
})
