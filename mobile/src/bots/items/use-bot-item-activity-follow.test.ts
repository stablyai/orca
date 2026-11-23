import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  useBotItemActivityFollow,
  type BotItemActivityScrollView
} from './use-bot-item-activity-follow'

const platform = vi.hoisted(() => ({ OS: 'ios' }))
vi.mock('react-native', () => ({ Platform: platform }))

const VIEW_HEIGHT = 600

type Follow = ReturnType<typeof useBotItemActivityFollow>

let renderer: ReactTestRenderer | null = null
let follow: Follow | null = null

afterEach(() => {
  platform.OS = 'ios'
  scopeKey = 'host\0bot\0item-1'
  act(() => renderer?.unmount())
  renderer = null
  follow = null
})

let scopeKey = 'host\0bot\0item-1'

function Harness() {
  follow = useBotItemActivityFollow({ scopeKey, hasItems: true })
  return null
}

/** A scroll view that lands where it is told, as a native one does. */
function fakeScrollView() {
  const view = {
    y: 0,
    contentHeight: 0,
    height: VIEW_HEIGHT,
    scrollTo: ({ y }: { y: number }) => {
      view.y = Math.max(0, Math.min(y, view.contentHeight - view.height))
    },
    scrollToEnd: () => {
      view.y = Math.max(0, view.contentHeight - view.height)
    },
    measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) =>
      callback(0, 0, 400, view.height)
  } satisfies BotItemActivityScrollView & { y: number; contentHeight: number; height: number }
  return view
}

type FakeScrollView = ReturnType<typeof fakeScrollView>

function event(view: FakeScrollView) {
  return {
    nativeEvent: {
      contentOffset: { y: view.y },
      contentSize: { height: view.contentHeight },
      layoutMeasurement: { height: view.height }
    }
  }
}

/** Where the view lands, reported as its scroll event. */
function settle(view: FakeScrollView) {
  act(() => follow!.onScroll(event(view)))
}

/** The page's activity grows (a new event, a sent comment) and the view reports its new size. */
function grow(view: FakeScrollView, height: number) {
  view.contentHeight = height
  act(() => follow!.onContentSizeChange(400, height))
}

/** The view's own height changes (first layout, the keyboard) and it reports the new size. */
function layout(view: FakeScrollView, height: number) {
  view.height = height
  act(() => follow!.onLayout({ nativeEvent: { layout: { height } } }))
}

function mount() {
  const view = fakeScrollView()
  act(() => {
    renderer = create(createElement(Harness))
  })
  act(() => follow!.ref(view))
  return view
}

function open() {
  const view = mount()
  view.contentHeight = 2000
  layout(view, VIEW_HEIGHT)
  settle(view)
  return view
}

it('opens at the end, follows new activity there, and holds a place the reader scrolled up to', () => {
  const view = open()
  expect(view.y).toBe(2000 - VIEW_HEIGHT)

  grow(view, 2300)
  expect(view.y).toBe(2300 - VIEW_HEIGHT)

  act(() => follow!.tail.beginUserScroll())
  view.y = 500
  settle(view)
  act(() => follow!.tail.endMomentum(event(view)))
  grow(view, 2600)
  expect(view.y).toBe(500)
  expect(follow!.tail.showJumpToTail).toBe(true)

  act(() => follow!.tail.jumpToTail())
  expect(view.y).toBe(2600 - VIEW_HEIGHT)
  grow(view, 2900)
  expect(view.y).toBe(2900 - VIEW_HEIGHT)
})

it('keeps a question it centred in view when new activity lands', () => {
  const view = open()
  // A question just below the view's middle, 100pt tall: centring it leaves the view near the end.
  act(() => follow!.center(200, 100, false))
  settle(view)
  const centred = view.y
  expect(centred).toBe(2000 - VIEW_HEIGHT + 200 - (VIEW_HEIGHT - 100) / 2)

  grow(view, 2400)
  expect(view.y).toBe(centred)
  expect(follow!.tail.showJumpToTail).toBe(true)
})

it('shows no Scroll to latest on a page shorter than the view, sized before its first layout', () => {
  const view = mount()
  grow(view, 300)
  layout(view, VIEW_HEIGHT)
  act(() => follow!.center(0, 100, false))
  expect(follow!.tail.showJumpToTail).toBe(false)
})

it('shows Scroll to latest when the view shrinks (the keyboard) under a reader near the end', () => {
  const view = open()
  act(() => follow!.center(200, 100, false))
  settle(view)
  expect(follow!.tail.showJumpToTail).toBe(false)

  layout(view, 300)
  expect(follow!.tail.showJumpToTail).toBe(true)
})

it('on web, where no drag events come, a scroll up holds its place and a scroll back follows', () => {
  platform.OS = 'web'
  const view = open()
  view.y = 500
  settle(view)
  grow(view, 2300)
  expect(view.y).toBe(500)
  expect(follow!.tail.showJumpToTail).toBe(true)

  view.y = 2300 - VIEW_HEIGHT
  settle(view)
  grow(view, 2600)
  expect(view.y).toBe(2600 - VIEW_HEIGHT)
})

it('on web, centring a question past the end does not take it back to following', () => {
  platform.OS = 'web'
  const view = open()
  view.y = 1000
  settle(view)
  // The question sits low enough that centring it runs into the end.
  act(() => follow!.center(700, 100, false))
  settle(view)
  expect(view.y).toBe(2000 - VIEW_HEIGHT)
  grow(view, 2300)
  expect(view.y).toBe(2000 - VIEW_HEIGHT)

  view.y = 2300 - VIEW_HEIGHT
  settle(view)
  grow(view, 2600)
  expect(view.y).toBe(2600 - VIEW_HEIGHT)
})

/** A web reader scrolls to `y`: the view lands there and says so. */
function readerScrollsTo(view: FakeScrollView, y: number) {
  view.y = y
  settle(view)
}

it("on web, centring on a page shorter than the view leaves reader scrolls the reader's", () => {
  platform.OS = 'web'
  const view = mount()
  grow(view, 300)
  layout(view, VIEW_HEIGHT)
  settle(view)
  act(() => follow!.center(0, 100, false))

  grow(view, 2000)
  readerScrollsTo(view, 2000 - VIEW_HEIGHT)
  grow(view, 2300)
  expect(view.y).toBe(2300 - VIEW_HEIGHT)
})

it('on web, a reader who turns back a smooth centring scroll takes the page back', () => {
  platform.OS = 'web'
  const view = open()
  readerScrollsTo(view, 1000)
  // Headed into the end; the view is caught on its way there, then pushed back up.
  act(() => follow!.center(700, 100, true))
  readerScrollsTo(view, 1100)
  readerScrollsTo(view, 900)

  readerScrollsTo(view, 2000 - VIEW_HEIGHT)
  grow(view, 2300)
  expect(view.y).toBe(2300 - VIEW_HEIGHT)
})

it('on web, Scroll to latest drops a centring scroll still on its way', () => {
  platform.OS = 'web'
  const view = open()
  readerScrollsTo(view, 1000)
  // Headed up to 750; Scroll to latest is tapped before any of its scroll events arrive.
  act(() => follow!.center(0, 100, true))
  act(() => follow!.jumpToTail())

  readerScrollsTo(view, 900)
  grow(view, 2300)
  expect(view.y).toBe(900)
})

it("on web, a centring scroll begun on one item does not claim the next item's scrolls", () => {
  platform.OS = 'web'
  const view = open()
  readerScrollsTo(view, 1000)
  act(() => follow!.center(0, 100, true))
  scopeKey = 'host\0bot\0item-2'
  act(() => renderer!.update(createElement(Harness)))

  readerScrollsTo(view, 900)
  grow(view, 2300)
  expect(view.y).toBe(900)
})
