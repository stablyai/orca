// @vitest-environment happy-dom
import {
  act,
  createElement as h,
  Fragment,
  startTransition,
  Suspense,
  useLayoutEffect,
  useMemo,
  type ReactNode
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { foldToolMessages } from '../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { MobileNativeChatMessage } from './native-chat/transcript/MobileNativeChatMessage'
import { MobileNativeChatScrollRootsBoundary } from './MobileNativeChatScrollRootsBoundary'
import { MobileNativeChatScrollMotion } from './mobile-native-chat-scroll-motion'
import {
  mobileNativeChatScrollFrame,
  mobileNativeChatReadingParts,
  mobileNativeChatVisible,
  MobileNativeChatScrollRoots
} from './mobile-native-chat-scroll-roots'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures,
  type MobileNativeChatDisclosureStore
} from './native-chat/transcript/mobile-native-chat-disclosure-store'
import { useMobileNativeChatRowKeys } from './native-chat/transcript/mobile-native-chat-row-keys'
import { useMobileNativeChatTurnDisclosure } from './native-chat/transcript/use-mobile-native-chat-turn-disclosure'

vi.mock('react-native', async () => {
  const React = await import('react')
  const View = (p: {
    children?: ReactNode
    testID?: string
    onPress?: () => void
    accessibilityLiveRegion?: string
  }) =>
    React.createElement(
      'div',
      { 'data-testid': p.testID, onClick: p.onPress, 'data-live': p.accessibilityLiveRegion },
      p.children
    )
  const ScrollView = React.forwardRef((p: { children?: ReactNode }, ref) => {
    const node = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(ref, () => ({
      getScrollableNode: () => node.current,
      getInnerViewNode: () => node.current?.firstElementChild
    }))
    return React.createElement(
      'div',
      { ref: node, className: 'viewport' },
      React.createElement('div', null, p.children)
    )
  })
  const animation = () => ({ start() {}, stop() {} })
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    View,
    Text: View,
    Pressable: View,
    ScrollView,
    Image: View,
    Platform: { OS: 'web' },
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    Animated: {
      Text: View,
      Value: class {
        setValue() {}
      },
      loop: animation,
      sequence: animation,
      timing: animation
    }
  }
})
vi.mock('lucide-react-native', () =>
  Object.fromEntries(
    'ArrowUp Bot Brain Check ChevronDown ChevronRight Copy Eye FileMinus2 FilePen FilePlus2 Folder Globe ListChecks MessageSquareMore Pencil Plug Search SquareChevronRight SquareTerminal Wrench Circle CircleCheck CircleDot'
      .split(' ')
      .map((key) => [key, () => null])
  )
)
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: () => null }))
vi.mock('../components/MobileSourceCopyButton', () => ({ MobileSourceCopyButton: () => null }))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../components/inline-text-selection', () => ({ INLINE_TEXT_SELECTION: false }))

let renderer: Root | undefined
let container: HTMLDivElement
let page: HTMLElement
let frameShift = 0
let roots: MobileNativeChatScrollRoots
let owners: (string | undefined)[]
let projected: (string | undefined)[]
let store: MobileNativeChatDisclosureStore
const abandoned = new Promise<void>(() => {})
const msg = (
  id: string,
  blocks: NativeChatMessage['blocks'],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage => ({ id, blocks, role, timestamp: null, source: 'transcript' })
const a = msg(
  'a',
  Array.from({ length: 6 }, (_, i) => ({
    type: 'tool-call',
    callId: `c${i}`,
    name: 'Bash',
    input: { command: `command ${i} ${'argument '.repeat(20)}` }
  }))
)
const thought = msg('r', [{ type: 'text', text: 'reason' }], 'reasoning')
const user = msg('u', [{ type: 'text', text: 'go' }], 'user')
const b = msg('b', [{ type: 'tool-call', callId: 'b', name: 'Bash', input: { command: 'b' } }])
function reader(node: Element, top: number) {
  node.dispatchEvent(new Event('touchstart'))
  node.scrollTop = top
  node.dispatchEvent(new Event('scroll'))
  node.dispatchEvent(new Event('touchend'))
}
function members(root: Element): Element[] {
  return Array.from(root.querySelectorAll('[data-testid^="chat-member:"]')).filter(
    (node) => !mobileNativeChatScrollFrame(node, root)
  )
}
function rect(node: Element): DOMRect {
  const viewport = node.closest('[data-chat-scroll-root]')
  let top = 0
  let height = 1000
  if (node === page) {
    return DOMRect.fromRect({ y: 100, height: 200, width: 400 })
  }
  if (viewport === node) {
    const parent = node.parentElement?.closest('[data-chat-scroll-root]')
    top = parent
      ? rect(node.parentElement!.closest('[data-testid^="chat-member:"]') ?? parent).top + 20
      : 40 + frameShift - page.scrollTop
    height = 160
  } else if (viewport) {
    const member = node.closest('[data-testid^="chat-member:"]')
    top =
      rect(viewport).top +
      Math.max(0, members(viewport).indexOf(member ?? node)) * 60 -
      viewport.scrollTop
    height = 60
  } else if (node.closest('[data-live], [data-testid="chat-row:u"]')) {
    top = -page.scrollTop
    height = 20
  } else {
    top = -page.scrollTop
  }
  return DOMRect.fromRect({ y: top, height, width: 400 })
}
function Shift({ value }: { value: number }): null {
  useLayoutEffect(() => {
    frameShift = value
  }, [value])
  return null
}
function Chat({
  rows,
  open = true,
  shown = true,
  scope = 'chat',
  shift = 0,
  suspend = false,
  structured = true,
  working = false
}: {
  rows: NativeChatMessage[]
  open?: boolean
  shown?: boolean
  scope?: string
  shift?: number
  suspend?: boolean
  structured?: boolean
  working?: boolean
}) {
  const current = useMobileNativeChatDisclosures(scope)
  const disclosures = useMemo(
    () =>
      open
        ? {
            ...current,
            read: (key: string) =>
              current.read(key) ?? (/^(run|line|diff):/.test(key) ? true : undefined)
          }
        : current,
    [current, open]
  )
  const drawn = useMemo(() => (structured ? rows : foldToolMessages(rows)), [rows, structured])
  const turns = useMobileNativeChatTurnDisclosure({
    messages: drawn,
    enabled: structured,
    isWorking: working,
    scopeKey: scope
  })
  const keys = useMobileNativeChatRowKeys(drawn, rows, scope, turns.presentation)
  useLayoutEffect(() => {
    store = current
    roots = current.roots
    owners = drawn.map((row) => keys.runOwners.get(row.id))
  })
  if (suspend) {
    projected = drawn.map((row) => keys.runOwners.get(row.id))
    throw abandoned
  }
  return h(
    MobileNativeChatDisclosureContext.Provider,
    { value: disclosures },
    h(
      MobileNativeChatScrollRootsBoundary,
      {
        rowKeys: keys,
        roots: current.roots,
        runPlacements: keys.runPlacements,
        layoutKey: '1'
      },
      h(Shift, { value: shift }),
      h(
        Fragment,
        { key: scope },
        shown &&
          drawn.map((message, i) =>
            h(MobileNativeChatMessage, {
              key: keys.keyOf(message),
              message,
              rowKey: keys.keyOf(message),
              ...turns.resolveRow(i, message),
              ...(open ? { foldedAway: false } : {}),
              runOwner: keys.runOwners.get(message.id),
              structuredActivityUi: structured
            })
          )
      )
    )
  )
}
function mount(structured = true) {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('navigator', { userAgent: 'AppleWebKit Safari' })
  container = document.createElement('div')
  page = document.createElement('main')
  page.style.overflowY = 'auto'
  document.body.append(page)
  page.append(container)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rect(this)
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(160)
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return this.getAttribute('data-short')
      ? 80
      : members(this).length * 60 +
          400 +
          this.querySelectorAll('.viewport').length * 60 +
          Number(this.getAttribute('data-growth') ?? 0)
  })
  renderer = createRoot(container)
  return (rows: NativeChatMessage[], rest: Partial<Parameters<typeof Chat>[0]> = {}) => {
    const render = () =>
      renderer!.render(h(Suspense, { fallback: null }, h(Chat, { rows, structured, ...rest })))
    act(() => (rest.suspend ? startTransition(render) : render()))
    act(() => vi.advanceTimersByTime(20))
  }
}
afterEach(() => {
  act(() => renderer?.unmount())
  page?.remove()
  renderer = undefined
  frameShift = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps real structured runs and nested offsets under their own viewport across reheading', () => {
  const draw = mount()
  draw([user, a])
  const owner = owners[1]
  const run = container.querySelector('[data-chat-scroll-root]')
  if (!(run instanceof HTMLElement)) {
    throw new Error('missing run viewport')
  }
  const detail = run.querySelector('[data-chat-scroll-root]')
  if (!(detail instanceof HTMLElement)) {
    throw new Error('missing command viewport')
  }
  const row = run.closest('[data-testid^="chat-row:"]')!
  reader(run, 100)
  reader(detail, 35)
  act(() => vi.advanceTimersByTime(160))
  roots.restoreAll()
  const clipped = run.querySelector('[data-testid="chat-member:call:c0"]')!
  expect(mobileNativeChatVisible(clipped, page)).toBe(false)
  expect(mobileNativeChatReadingParts(row)).toContain(run)
  expect(mobileNativeChatReadingParts(row)).not.toContain(clipped)
  const anchor = run.querySelector('[data-testid="chat-member:call:c3"]')!
  const offset = rect(anchor).top - rect(run).top
  draw([user, thought, a], { shift: 80 })
  expect(owners[1]).toBe(owner)
  const restored = container.querySelector('[data-chat-scroll-root]')!
  expect(
    rect(restored.querySelector('[data-testid="chat-member:call:c3"]')!).top - rect(restored).top
  ).toBe(offset)
  expect(restored.querySelector('[data-chat-scroll-root]')?.scrollTop).toBe(35)
  const top = restored.scrollTop
  draw([user, thought, a], { shown: false, shift: 80 })
  draw([user, thought, a], { shift: 80 })
  expect(container.querySelector('[data-chat-scroll-root]')?.scrollTop).toBe(top)
  const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }
  roots.observeWith(observer)
  expect(observer.observe).toHaveBeenCalledWith(container.querySelector('[data-chat-scroll-root]'))
  const late = document.createElement('div')
  const content = document.createElement('div')
  late.append(content)
  container.append(late)
  late.setAttribute('data-short', 'yes')
  store.runScroll.set('late', { top: 37, followsEnd: false, member: 'missing', offset: 10 })
  const stop = roots.register('late', late, content, 'late', 'late', false)
  expect(late.scrollHeight).toBeLessThan(late.clientHeight)
  expect(observer.observe).toHaveBeenCalledWith(content)
  roots.capture(new Set(), false)
  expect(store.runScroll.get('late')?.top).toBe(37)
  late.removeAttribute('data-short')
  roots.restoreAll()
  expect(late.scrollTop).toBe(37)
  expect(store.runScroll.get('late')?.member).toBeUndefined()
  const removed = vi.spyOn(late, 'removeEventListener')
  const replacement = document.createElement('div')
  late.replaceChildren(replacement)
  const replaced = roots.register('late', late, replacement, 'late', 'late', false)
  observer.unobserve.mockClear()
  stop()
  expect(roots.frame('late')).toBe(late)
  expect(observer.unobserve.mock.calls.some(([node]) => node === late)).toBe(false)
  expect(observer.unobserve.mock.calls.some(([node]) => node === replacement)).toBe(false)
  late.remove()
  roots.restoreAll()
  replaced()
  expect(roots.frame('late')).toBeUndefined()
  expect(observer.unobserve.mock.calls.some(([node]) => node === content)).toBe(true)
  expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function))
})

it.each([true, false])(
  'issues fresh displayed owners through split and merge instead of reviving retired choices (structured=%s)',
  (structured) => {
    const draw = mount(structured)
    draw([user, a, b], { working: true })
    const original = owners[1]
    const oldKey = `run:${original}`
    act(() => store.write(oldKey, false))
    store.runScroll.set(oldKey, { top: 111, followsEnd: false })
    const splitRows = [
      user,
      a,
      msg('break', [{ type: 'text', text: 'answer' }], structured ? 'assistant' : 'user'),
      b
    ]
    const registry = roots
    draw(splitRows, { suspend: true, working: true })
    expect(projected[1]).not.toBe(original)
    expect(owners[1]).toBe(original)
    expect(roots).toBe(registry)
    expect(store.runScroll.get(oldKey)?.top).toBe(111)
    const tentative = [...projected]
    draw(splitRows, { working: true })
    const split = [owners[1], owners[3]]
    expect(new Set([original, ...split]).size).toBe(3)
    expect(owners).toEqual(tentative)
    const reused = roots.frame(`run:${split[0]}`)!
    reader(reused, 40)
    draw([user, a, b])
    expect([original, ...split]).not.toContain(owners[1])
    expect(store.read(oldKey)).toBe(false)
    expect(store.runScroll.get(oldKey)?.top).toBe(111)
    expect(roots.frame(`run:${owners[1]}`)).toBe(reused)
    expect(reused.scrollTop).toBe(40)
    expect(store.runScroll.get(`run:${owners[1]}`)?.followsEnd).toBe(false)
  }
)

it('releases on close/scope change, and separates work-follow from reader chaining', async () => {
  const draw = mount()
  draw([user, a])
  const run = container.querySelector('[data-chat-scroll-root]')!
  const detail = run.querySelector('[data-chat-scroll-root]')!
  vi.stubGlobal('navigator', { userAgent: 'AppleWebKit Chrome' })
  const pageMotion = new MobileNativeChatScrollMotion()
  const detach = pageMotion.attach(page)
  pageMotion.reconciled(100, 1000)
  reader(run, 100)
  reader(detail, 35)
  await vi.advanceTimersByTimeAsync(160)
  reader(run, run.scrollHeight - run.clientHeight - 20)
  await vi.advanceTimersByTimeAsync(160)
  const parked = run.scrollTop
  run.setAttribute('data-growth', '60')
  roots.restoreAll()
  expect(run.scrollTop).toBe(parked)
  draw([user, a, b])
  expect(run.scrollTop).toBe(run.scrollHeight - run.clientHeight)
  run.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(160)
  expect(pageMotion.scrolled(100, 1000, () => false).by).toBe('none')
  run.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true }))
  expect(pageMotion.scrolled(90, 1000, () => false).by).toBe('reader')
  pageMotion.release()
  act(() => container.querySelector<HTMLElement>('[data-live]')!.click())
  expect(run.hasAttribute('data-chat-scroll-root')).toBe(false)
  draw([user, a], { scope: 'intermediate' })
  draw([user, a], { scope: 'other' })
  vi.stubGlobal('navigator', { userAgent: 'AppleWebKit Safari' })
  draw([user, a], { scope: 'live', open: false, working: true })
  act(() => container.querySelector<HTMLElement>('[data-live]')!.click())
  const key = `run:${owners[1]}`
  const live = roots.frame(key)!
  const end = live.scrollTop
  expect(end).toBe(live.scrollHeight - live.clientHeight)
  reader(live, end - 100)
  draw([user, a], { scope: 'live', open: false, working: true, shift: 40 })
  expect(roots.frame(key)).toBe(live)
  expect(live.scrollTop).toBe(end - 100)
  expect(store.runScroll.get(key)?.followsEnd).toBe(false)
  reader(live, live.scrollHeight - live.clientHeight - 20)
  await vi.advanceTimersByTimeAsync(160)
  draw([user, a, b], { scope: 'live', open: false, working: true, shift: 40 })
  expect(live.scrollTop).toBe(live.scrollHeight - live.clientHeight)
  draw([user, a, b], { scope: 'live', open: false, working: true, shown: false, shift: 40 })
  store.runScroll.set(key, { top: 37, followsEnd: false })
  draw([user, a, b], { scope: 'live', open: false, working: true, shift: 40 })
  expect(roots.frame(key)?.scrollTop).toBe(37)
  detach()
  pageMotion.release()
})

it('keeps the actual changed task checklist through eviction, isolated by chat', () => {
  const draw = mount()
  const tasks = msg(
    'tasks',
    [false, true].map((done) => ({
      type: 'tool-call',
      callId: String(done),
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Remember', status: done ? 'completed' : 'pending', activeForm: 'Remembering' }
        ]
      }
    }))
  )
  draw([user, tasks])
  const count = () => container.textContent?.match(/Remember/g)?.length ?? 0
  const before = count()
  const disclosure = Array.from(container.querySelectorAll('div')).findLast(
    (node) => node.textContent === 'Full task list'
  )
  if (!disclosure) {
    throw new Error('missing changed-task disclosure')
  }
  act(() => disclosure.click())
  expect(count()).toBe(before + 1)
  draw([user, tasks], { shown: false })
  draw([user, tasks])
  expect(count()).toBe(before + 1)
  draw([user, tasks], { scope: 'different' })
  expect(count()).toBe(before)
})

it("forgets a closed tool line's nested command and output positions, not its neighbours'", () => {
  const at = { top: 30, followsEnd: false }
  const memory = new Map(
    ['run:o', 'run:o/line:a:command', 'run:o/line:a:output', 'line:a:command']
      .concat(['run:o/line:ab:command', 'diff:src/line:a.ts'])
      .map((address) => [address, at] as const)
  )
  new MobileNativeChatScrollRoots(memory, 10).forget('line:a')
  expect([...memory.keys()]).toEqual(['run:o', 'run:o/line:ab:command', 'diff:src/line:a.ts'])
})
