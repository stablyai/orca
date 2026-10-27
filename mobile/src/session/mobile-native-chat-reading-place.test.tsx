import { createElement as h, Fragment, useMemo, type ReactElement, type ReactNode } from 'react'
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestRendererJSON as Node
} from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { splitNativeChatBlocks } from '../../../src/shared/native-chat/tools/native-chat-tool-fold'
import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import {
  useMobileNativeChatRowKeys,
  type MobileNativeChatRowKeys
} from './mobile-native-chat-row-keys'
import {
  mobileNativeChatReadingPlace,
  mobileNativeChatRowId
} from './mobile-native-chat-reading-place'
import { MobileNativeChatPageList } from './MobileNativeChatPageList'
import { ToolRun } from './MobileNativeChatToolRun'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

const platform = vi.hoisted(() => ({ OS: 'web' }))
const scrollable = vi.hoisted(() => {
  const held: { node: unknown } = { node: null }
  return held
})

vi.mock('react-native', async () => {
  const React = await import('react')
  class ScrollView extends React.Component<{ children?: ReactNode }> {
    scrollToEnd = (): void => {}
    scrollTo = (): void => {}
    getScrollableNode = (): unknown => scrollable.node
    getInnerViewNode = (): object => ({})
    render(): ReactNode {
      return React.createElement('div', null, this.props.children)
    }
  }
  const settled = () => ({ start: (): void => {}, stop: (): void => {} })
  return {
    Platform: platform,
    Text: 'span',
    View: 'div',
    Pressable: 'button',
    ScrollView,
    Animated: {
      Text: 'span',
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: settled,
      timing: settled
    },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 })
  }
})
vi.mock('lucide-react-native', () => {
  const icon = () => null
  const names = ['Bot', 'Brain', 'Check', 'ChevronRight', 'Circle', 'CircleCheck', 'CircleDot']
  const more = ['Eye', 'FileMinus2', 'FilePen', 'FilePlus2', 'Folder', 'Globe', 'ListChecks']
  const rest = ['MessageSquareMore', 'Pencil', 'Plug', 'Search', 'SquareTerminal', 'Wrench']
  return Object.fromEntries([...names, ...more, ...rest].map((name) => [name, icon]))
})
vi.mock('./mobile-native-chat-tool-styles', () => ({
  toolStyles: {},
  toolType: () => ({ row: {}, meta: {}, code: {} })
}))
vi.mock('../components/MobileSourceCopyButton', () => ({ MobileSourceCopyButton: () => null }))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../components/inline-text-selection', () => ({ INLINE_TEXT_SELECTION: false }))

// The browser's resize step: after layout, before paint.
const observers = new Map<() => void, Set<unknown>>()
const resized = () => act(() => observers.forEach((_, deliver) => deliver()))
// Only observers watching `target` hear about it, as in the browser.
const resizedOnly = (target: unknown) =>
  act(() => observers.forEach((targets, deliver) => targets.has(target) && deliver()))
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(private readonly deliver: () => void) {
      observers.set(deliver, new Set())
    }
    observe(target: unknown): void {
      observers.get(this.deliver)?.add(target)
    }
    unobserve(target: unknown): void {
      observers.get(this.deliver)?.delete(target)
    }
    disconnect(): void {
      observers.delete(this.deliver)
    }
  }
)

const mountedRenderers = new Set<ReactTestRenderer>()

afterEach(() => {
  act(() => {
    for (const renderer of mountedRenderers) {
      renderer.unmount()
    }
  })
  mountedRenderers.clear()
  scrollable.node = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const say = (id: string, role: 'user' | 'assistant', text: string): NativeChatMessage => ({
  id,
  role,
  timestamp: null,
  source: 'transcript',
  blocks: [{ type: 'text', text }]
})
const edit = (n: number): NativeChatBlock => {
  const lines = (word: string): string => Array.from({ length: 30 }, () => word).join('\n')
  const input = { file_path: `f${n}.ts`, old_string: lines('old'), new_string: lines('new') }
  return { type: 'tool-call', name: 'Edit', callId: `c${n}`, input }
}
const run = (n: number): NativeChatMessage[] => [
  { ...say(`a${n}`, 'assistant', ''), blocks: [edit(n)] },
  { ...say(`r${n}`, 'user', ''), blocks: [{ type: 'tool-result', callId: `c${n}`, output: 'ok' }] }
]
const chat = [say('u0', 'user', 'first'), say('x0', 'assistant', 'answer'), say('u1', 'user', 'go')]
  .concat({
    ...say('a1', 'assistant', 'On it'),
    blocks: [{ type: 'text', text: 'On it' }, edit(1)]
  })
  .concat(run(1).slice(1), ...Array.from({ length: 39 }, (_, i) => run(i + 2)))

type Box = { id: string; top: number; bottom: number; end: number; parent: number; rows: boolean }
type Element = {
  getAttribute: () => string
  getBoundingClientRect: () => { top: number; bottom: number }
  querySelectorAll: (selector: string) => Element[]
  children: Element[]
  nextElementSibling: Element | null
}

const oldHostTail = (): NativeChatMessage[] => JSON.parse(JSON.stringify(chat))
const from = (id: string) => oldHostTail().slice(chat.findIndex((m) => m.id === id))

// Model end-anchored scrollTop=0 at the tail and negative offsets above; prepending history must not shift the view.
function page(tree: () => Node | Node[] | null) {
  const boxes = (): Box[] => {
    const out: Box[] = []
    let y = 0
    const walk = (node: Node | string, parent: number): void => {
      if (typeof node === 'string' || node.type === 'span') {
        y += typeof node === 'string' ? 0 : 20
        return
      }
      const id = String(node.props.testID ?? '')
      const rows = node.props['data-chat-rows'] !== undefined
      const at = out.push({ id, top: y, bottom: y, end: 0, parent, rows }) - 1
      node.children?.forEach((child) => walk(child, at))
      out[at] = { ...out[at]!, bottom: y, end: out.length }
    }
    walk({ type: 'page', props: {}, children: [tree() ?? []].flat() }, -1)
    return out
  }
  const element = (all: Box[], at: number): Element => {
    const box = all[at]!
    const siblings = (parent: number): Element[] =>
      all.flatMap((other, i) => (other.parent === parent ? [element(all, i)] : []))
    return {
      getAttribute: () => box.id,
      getBoundingClientRect: () => ({
        top: box.top - node.viewTop(),
        bottom: box.bottom - node.viewTop()
      }),
      querySelectorAll: (inner: string) => select(all, at + 1, box.end, inner),
      get children() {
        return siblings(at)
      },
      get nextElementSibling() {
        const next = all.findIndex((other, i) => i > at && other.parent === box.parent)
        return next === -1 ? null : element(all, next)
      }
    }
  }
  const select = (all: Box[], from: number, to: number, selector: string): Element[] => {
    const prefix = /\^="([^"]+)"/.exec(selector)?.[1] ?? '?'
    return all.flatMap((box, at) =>
      at >= from && at < to && box.id.startsWith(prefix) ? [element(all, at)] : []
    )
  }
  let scrollTop = 0
  const listeners = new Map<string, () => void>()
  const node = {
    writes: 0,
    get scrollTop(): number {
      return scrollTop
    },
    set scrollTop(value: number) {
      node.writes += 1
      scrollTop = value
    },
    clientHeight: 200,
    get scrollHeight(): number {
      return boxes()[0]?.bottom ?? 0
    },
    viewTop: (): number => Math.max(0, node.scrollHeight - node.clientHeight) + node.scrollTop,
    showFrom: (y: number): void => {
      node.scrollTop = y - Math.max(0, node.scrollHeight - node.clientHeight)
    },
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: node.clientHeight }),
    addEventListener: (type: string, listener: () => void): void => {
      listeners.set(type, listener)
    },
    removeEventListener: (type: string): void => {
      listeners.delete(type)
    },
    touch: (type: 'touchstart' | 'touchend'): void => listeners.get(type)?.(),
    querySelectorAll: (selector: string): Element[] => select(boxes(), 0, Infinity, selector),
    querySelector: (): Element | null => {
      const all = boxes()
      const at = all.findIndex((box) => box.rows)
      return at === -1 ? null : element(all, at)
    },
    top: (id: string): number =>
      (boxes().find((box) => box.id === id)?.top ?? Number.NaN) - node.viewTop()
  }
  return node
}

function Row({
  message,
  rowKey,
  joined = 0,
  workRun,
  joinsWorkRun
}: {
  message: NativeChatMessage
  rowKey: string
  joined?: number
  workRun?: readonly NativeChatMessage[]
  joinsWorkRun?: boolean
}): ReactElement | null {
  if (joinsWorkRun) {
    return null
  }
  const { prose, tools } = splitNativeChatBlocks((workRun ?? [message]).flatMap((m) => m.blocks))
  const words = prose
    .map((block, i) => h('span', { key: i }, block.type === 'text' ? block.text : ''))
    .concat(Array.from({ length: joined }, (_, i) => h('span', { key: `joined:${i}` }, 'joined')))
  const run = tools.length > 0 && h(ToolRun, { blocks: tools })
  return h('div', { testID: mobileNativeChatRowId(rowKey) }, words, run)
}

let shownKeys!: MobileNativeChatRowKeys

function Chat(props: {
  messages: NativeChatMessage[]
  following: boolean
  live: boolean
  joined?: number
  runs?: boolean
  status?: boolean
}): ReactElement {
  const folded = useMemo(
    () => foldMobileNativeChatMessages(props.messages, 'claude'),
    [props.messages]
  )
  const turns = useMobileNativeChatTurnDisclosure({
    messages: folded,
    enabled: props.runs === true,
    isWorking: false,
    scopeKey: 'chat'
  })
  const keys = useMobileNativeChatRowKeys(folded, props.messages, 'chat', turns.presentation)
  shownKeys = keys
  return h(MobileNativeChatPageList, {
    ref: null,
    rows: turns.listMessages,
    rowKeys: keys,
    runs: turns.presentation.workRuns.heads,
    isFollowing: () => props.following,
    onEndDistance: () => {},
    renderItem: ({ item, index }) => {
      const { workRun, joinsWorkRun } = turns.resolveRow(index, item)
      const row = h(Row, {
        message: item,
        rowKey: keys.keyOf(item),
        joined: item === folded.at(-1) ? props.joined : 0,
        workRun,
        joinsWorkRun
      })
      // Turn status draws beside its row, untagged.
      return props.status
        ? h(
            Fragment,
            null,
            row,
            ...Array.from({ length: 5 }, (_, i) => h('span', { key: i }, 'Done'))
          )
        : row
    },
    layoutKey: 'layout',
    contentContainerStyle: null,
    header: h('div', { testID: 'header' }, h('span', null, 'Loading')),
    footer: props.live ? h('span', null, 'Working') : null,
    emptyStateView: null,
    onScroll: () => {}
  })
}

function mount(
  messages: NativeChatMessage[],
  options: { following: boolean; live: boolean; runs?: boolean; status?: boolean } = {
    following: false,
    live: false
  }
) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(h('div'))
    mountedRenderers.add(renderer)
  })
  const scroller = page(() => renderer.toJSON())
  scrollable.node = scroller
  const show = (next: NativeChatMessage[], joined = 0): number => {
    const before = scroller.writes
    act(() => renderer.update(h(Chat, { ...options, messages: next, joined })))
    return scroller.writes - before
  }
  vi.useFakeTimers({ now: 10_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const scrolled = () =>
    act(() =>
      renderer.root.find((n) => n.props.onScroll && n.props.scrollEventThrottle).props.onScroll({})
    )
  const rest = () =>
    act(() => {
      vi.advanceTimersByTime(400)
    })
  const read = (move: () => void) => {
    move()
    scrolled()
    rest()
  }
  show(messages)
  const find = (id: string) => renderer.root.find((n) => n.props.testID === id)
  const press = (id: string) => act(() => find(id).findAllByType('button')[0]!.props.onPress())
  const drawn = (id: string) => renderer.root.findAll((n) => n.props.testID === id).length
  const lines = (id: string) => find(id).findAllByType('span').length
  const rows = () =>
    renderer.root
      .findAll((n) => n.type === 'div' && String(n.props.testID).startsWith('chat-row:'))
      .map((n) => n.props.testID)
  return { scroller, show, press, drawn, lines, find, rows, scrolled, rest, read }
}

it('keeps the line a reader was on, its run open, when older messages join the run from an old host', () => {
  // Exercise anchoring both inside a run and at Load earlier when older calls absorb the visible orphan result.
  for (const atTop of [false, true]) {
    const chat0 = mount(from('r31'))
    chat0.press(mobileNativeChatRowId('a32'))
    chat0.press('chat-member:call:c34')
    const opened = chat0.lines('chat-member:call:c34')
    chat0.read(() => (chat0.scroller.scrollTop += chat0.scroller.top('chat-member:call:c34')))
    // Old hosts can replay the whole tail as new objects with unchanged ids.
    for (const [older, first] of [
      ['r21', 'c32'],
      ['u0', 'c22']
    ] as const) {
      if (atTop) {
        chat0.read(() => chat0.scroller.showFrom(0))
      }
      const line = `chat-member:call:${atTop ? first : 'c34'}`
      const top = chat0.scroller.top(line)
      expect(chat0.show(from(older))).toBeLessThanOrEqual(1)
      expect(chat0.scroller.top(line)).toBe(top)
    }

    expect(chat0.rows().slice(0, 3)).toEqual(['u0', 'x0', 'u1'].map(mobileNativeChatRowId))
    expect(chat0.lines('chat-member:call:c34')).toBe(opened)
    expect(chat0.drawn('chat-member:call:c1')).toBe(1)
    expect(shownKeys.current('r21')).toBe('a32')

    chat0.show([...oldHostTail(), say('done', 'assistant', 'Done'), say('ask', 'user', 'next')])
    expect(chat0.drawn(mobileNativeChatRowId('a32'))).toBe(1)
    expect(chat0.drawn('chat-member:call:c34')).toBe(1)
  }

  // Both collapsed headers and open lines must stay anchored as older calls join above.
  const later = Array.from({ length: 10 }, (_, i) => say(`t${i}`, 'user', 'later'))
  for (const open of [false, true]) {
    const tail = mount([...from('r21'), ...later])
    if (open) {
      tail.press(mobileNativeChatRowId('a22'))
      tail.read(() => (tail.scroller.scrollTop += tail.scroller.top('chat-member:call:c27') + 40))
    }
    const before = tail.scroller.top(mobileNativeChatRowId('t0'))
    tail.show([...oldHostTail(), ...later])
    expect(tail.scroller.top(mobileNativeChatRowId('t0'))).toBe(before)
  }
})

it('holds back a change below a scrolling reader until they rest, then keeps their line', () => {
  const rows = Array.from({ length: 12 }, (_, i) => say(`m${i}`, i % 2 ? 'assistant' : 'user', 'x'))
  const chat0 = mount(rows)
  chat0.scroller.showFrom(40)
  chat0.scrolled()
  // A correction mid-fling would stop iOS momentum; hold the below-reader reply until rest.
  const line = chat0.scroller.top(mobileNativeChatRowId('m4'))
  expect(chat0.show([...rows, say('n1', 'assistant', 'reply')])).toBe(0)
  expect(chat0.drawn(mobileNativeChatRowId('n1'))).toBe(0)
  expect(chat0.scroller.top(mobileNativeChatRowId('m4'))).toBe(line)
  chat0.rest()
  expect(chat0.drawn(mobileNativeChatRowId('n1'))).toBe(1)
  expect(chat0.scroller.top(mobileNativeChatRowId('m4'))).toBe(line)
})

it('keeps a parked reader on their line when the list viewport changes height, as when the composer grows', () => {
  const rows = Array.from({ length: 12 }, (_, i) => say(`m${i}`, i % 2 ? 'assistant' : 'user', 'x'))
  const chat0 = mount(rows)
  chat0.read(() => chat0.scroller.showFrom(40))
  const line = chat0.scroller.top(mobileNativeChatRowId('m4'))

  chat0.scroller.clientHeight = 120
  resizedOnly(chat0.scroller)

  expect(chat0.scroller.top(mobileNativeChatRowId('m4'))).toBe(line)
})

it("holds a row's look with its messages: what the chat's state adds lands once the reader rests", () => {
  const rows = Array.from({ length: 12 }, (_, i) => say(`m${i}`, i % 2 ? 'assistant' : 'user', 'x'))
  const chat0 = mount(rows)
  chat0.scroller.showFrom(40)
  chat0.scrolled()
  const line = chat0.scroller.top(mobileNativeChatRowId('m4'))
  expect(chat0.show(rows, 3)).toBe(0)
  expect(chat0.lines(mobileNativeChatRowId('m11'))).toBe(1)
  expect(chat0.scroller.top(mobileNativeChatRowId('m4'))).toBe(line)
  chat0.rest()
  expect(chat0.lines(mobileNativeChatRowId('m11'))).toBe(4)
  expect(chat0.scroller.top(mobileNativeChatRowId('m4'))).toBe(line)
})

it('draws a run once when an older page brings in its start while the reader moves', () => {
  const call = (id: string): NativeChatMessage => ({
    ...say(id, 'assistant', ''),
    blocks: [{ type: 'tool-call', name: 'Bash', callId: id, input: { command: id } }]
  })
  const thought: NativeChatMessage = { ...say('t', 'assistant', 'weighing it'), role: 'reasoning' }
  const later = Array.from({ length: 12 }, (_, i) =>
    say(`m${i}`, i % 2 ? 'assistant' : 'user', 'x')
  )
  const chat0 = mount([thought, call('b'), ...later], { following: false, live: false, runs: true })
  chat0.scroller.showFrom(40)
  chat0.scrolled()
  chat0.show([say('u', 'user', 'go'), call('a'), thought, call('b'), ...later])
  const once = ['u', 'a', 'm0'].map(mobileNativeChatRowId)
  expect(chat0.rows().slice(0, 3)).toEqual(once)
  expect(chat0.drawn('chat-member:run')).toBe(1)
  chat0.rest()
  expect(chat0.rows().slice(0, 3)).toEqual(once)
  expect(chat0.drawn('chat-member:run')).toBe(1)
})

it('opens a chat whose newest rows are short and older ones tall without drawing in a loop', () => {
  const tall = Array.from({ length: 12 }, (_, i) => ({
    ...say(`t${i}`, 'assistant', ''),
    blocks: Array.from({ length: 12 }, () => ({ type: 'text' as const, text: 'line' }))
  }))
  const short = Array.from({ length: 24 }, (_, i) =>
    say(`s${i}`, i % 2 ? 'assistant' : 'user', 'x')
  )
  const chat0 = mount([...tall, ...short], { following: true, live: false })
  expect(chat0.drawn(mobileNativeChatRowId('t11'))).toBe(1)
})

it('draws a bounded tail again once a reader who scrolled back through history returns to it', () => {
  // Rows and their status lines are sized so a cut that drops a row's status would draw it back.
  const messages = Array.from({ length: 200 }, (_, i) => ({
    ...say(`m${i}`, i % 2 ? 'assistant' : 'user', ''),
    blocks: [0, 1].map((line) => ({ type: 'text' as const, text: `message ${i}.${line}` }))
  }))
  const options = { following: true, live: false, status: true }
  const chat0 = mount(messages, options)
  const tail = chat0.rows().length
  options.following = false
  chat0.show(messages)
  for (let page = 0; page < 8; page += 1) {
    chat0.read(() => chat0.scroller.showFrom(0))
  }
  expect(chat0.rows().length).toBeGreaterThan(tail * 2)

  options.following = true
  chat0.show(messages)
  chat0.read(() => (chat0.scroller.scrollTop = 0))
  expect(chat0.rows().length).toBeLessThanOrEqual(tail)
  expect(chat0.rows().at(-1)).toBe(mobileNativeChatRowId('m199'))
})

it('holds a row the reader taps open in place, and a reply below waits out a flick', () => {
  const later = Array.from({ length: 10 }, (_, i) => say(`t${i}`, 'user', 'later'))
  const chat0 = mount([...from('r21'), ...later])
  const header = mobileNativeChatRowId('a22')
  chat0.read(() => (chat0.scroller.scrollTop += chat0.scroller.top(header) - 40))
  chat0.scroller.touch('touchstart')
  chat0.scroller.touch('touchend')
  const before = chat0.scroller.top(header)
  chat0.press(header)
  resized()
  expect(chat0.scroller.top(header)).toBe(before)

  // Touch release can start a fling; it is not evidence the list is at rest.
  chat0.scroller.touch('touchstart')
  chat0.scroller.scrollTop -= 30
  chat0.scrolled()
  chat0.scroller.touch('touchend')
  expect(chat0.show([...from('r21'), ...later, say('n1', 'assistant', 'reply')])).toBe(0)
  expect(chat0.drawn(mobileNativeChatRowId('n1'))).toBe(0)
})

it('at the cap, a trim and an append of equal height hold a parked reader and leave a following one to follow', () => {
  const rows = Array.from({ length: 13 }, (_, i) =>
    say(`m${i}`, i % 2 ? 'assistant' : 'user', `message ${i}`)
  )
  for (const options of [
    { following: true, live: false },
    { following: true, live: true },
    { following: false, live: false }
  ]) {
    const chat0 = mount(rows.slice(0, 12), options)
    chat0.read(() =>
      options.following ? (chat0.scroller.scrollTop = 0) : chat0.scroller.showFrom(50)
    )
    const before = {
      scrollTop: chat0.scroller.scrollTop,
      m4: chat0.scroller.top(mobileNativeChatRowId('m4'))
    }

    const writes = chat0.show(rows.slice(1))

    expect(writes).toBe(options.following ? 0 : 1)
    if (options.following) {
      expect(chat0.scroller.scrollTop).toBe(before.scrollTop)
    } else {
      expect(chat0.scroller.top(mobileNativeChatRowId('m4'))).toBe(before.m4)
    }
  }

  // Sequential and parallel trims split results to opposite sides; orphan results must never inherit a run’s key.
  const output = (n: number): NativeChatMessage => ({
    ...say(`o${n}`, 'user', ''),
    role: 'tool',
    blocks: [{ type: 'tool-result', callId: `c${n}`, output: 'ok' }]
  })
  const six = [1, 2, 3, 4, 5, 6]
  const calls = (id: string) =>
    six.map((n) => ({ ...say(`${id}${n}`, 'assistant', ''), blocks: [edit(n)] }))
  const outputs = { ...output(1), id: 'U', blocks: six.flatMap((n) => output(n).blocks) }
  for (const [source, head, orphan, last, absorbed] of [
    [chat.slice(3, 15), 'a1', 'r1', 11, []],
    [calls('p').concat(six.map(output)), 'p1', 'o1', 6, ['o1', 'o2', 'o3', 'o4']],
    [calls('q').concat(outputs), 'q1', 'U', 6, ['U']]
  ] as const) {
    const top = mount([...source, ...rows])
    top.press(mobileNativeChatRowId(head))
    top.read(() => (top.scroller.scrollTop += top.scroller.top('chat-member:call:c6') - 10))
    const trim = (trimmed: number) => {
      top.show([...source.slice(trimmed), ...rows, say(`done${trimmed}`, 'assistant', 'Done')])
      const run = top.find(mobileNativeChatRowId(head))
      expect(run.findAll((n) => n.props.testID === 'chat-member:call:c6')).toHaveLength(1)
      expect(top.scroller.top('chat-member:call:c6')).toBe(10)
    }
    trim(1)
    expect(top.drawn(mobileNativeChatRowId(orphan))).toBe(1)
    trim(2)
    trim(4)
    top.show([...source, ...rows, say('done4', 'assistant', 'Done')])
    expect(absorbed.map(shownKeys.current)).toEqual(absorbed.map(() => head))
    top.show([...source.slice(last), ...rows, say('done', 'assistant', 'Done')])
    expect(top.drawn(mobileNativeChatRowId(head))).toBe(0)
  }

  const reader = mount([...chat.slice(3, 15), ...rows])
  reader.press(mobileNativeChatRowId('a1'))
  reader.read(() => (reader.scroller.scrollTop += reader.scroller.top('chat-member:call:c1')))
  const next = reader.scroller.top('chat-member:call:c2')
  expect(next).toBeGreaterThan(0)
  reader.show([...chat.slice(4, 15), ...rows, say('done', 'assistant', 'Done')])
  expect(reader.scroller.top('chat-member:call:c2')).toBe(next)
})

it('a roster keeps its key when the fold moves it, and the rows the reader saw after it stay put', () => {
  const sibling = (id: string): NativeChatMessage => ({
    ...say(id, 'user', ''),
    role: 'system',
    blocks: [
      { type: 'text', text: `Ran subagent ${id}` },
      { type: 'subagent', id: `agent-${id}`, label: id, state: 'completed', groupId: 'turn-1' }
    ]
  })
  const said = (name: string) =>
    Array.from({ length: 12 }, (_, i) => say(`${name}${i}`, i % 2 ? 'assistant' : 'user', name))
  const all = [...said('old'), sibling('s1'), ...said('mid'), sibling('s2'), ...said('new')]
  const chat0 = mount(all.slice(25))
  const tops = (ids: string[]) => ids.map((id) => chat0.scroller.top(mobileNativeChatRowId(id)))
  chat0.read(() => chat0.scroller.showFrom(20))
  const below = tops(['new0', 'new5'])
  expect(chat0.show(all)).toBeLessThanOrEqual(1)
  expect(tops(['new0', 'new5'])).toEqual(below)
  expect(chat0.drawn(mobileNativeChatRowId('s2'))).toBe(1)
  chat0.read(() => (chat0.scroller.scrollTop += chat0.scroller.top(mobileNativeChatRowId('s2'))))
  const after = tops(['mid0', 'mid5'])
  expect(chat0.show(all.slice(13))).toBeLessThanOrEqual(1)
  expect(tops(['mid0', 'mid5'])).toEqual(after)
  expect(chat0.drawn(mobileNativeChatRowId('s2'))).toBe(1)
})

it('keeps the nearest rows off screen as stand-ins when turn-status lines sit between them and the view', () => {
  type Line = { testID: string; top: number; bottom: number }
  const lines: Line[] = [
    { testID: mobileNativeChatRowId('above'), top: -300, bottom: -100 },
    { testID: '', top: -100, bottom: -80 },
    { testID: mobileNativeChatRowId('shown'), top: -80, bottom: 280 },
    { testID: '', top: 280, bottom: 300 },
    { testID: mobileNativeChatRowId('below'), top: 300, bottom: 500 }
  ]
  const children = lines.map((line) => ({
    getAttribute: () => line.testID || null,
    getBoundingClientRect: () => line,
    querySelectorAll: () => [],
    nextElementSibling: null
  }))
  const box = { ...children[0]!, children }
  const scroller = {
    scrollTop: 0,
    scrollHeight: 800,
    clientHeight: 200,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    querySelectorAll: () => [],
    querySelector: () => box
  }

  const place = mobileNativeChatReadingPlace(scroller, {
    current: () => undefined,
    placement: () => 'p'
  })

  expect(place.map((unit) => unit.key)).toEqual(['shown', 'below', 'above'])
})
