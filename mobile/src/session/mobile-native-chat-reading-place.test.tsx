import { createElement as h, Fragment, useMemo, type ReactElement, type ReactNode } from 'react'
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestRendererJSON as Node
} from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { splitNativeChatBlocks } from '../../../src/shared/native-chat-tool-fold'
import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import {
  useMobileNativeChatRowKeys,
  type MobileNativeChatRowKeys
} from './mobile-native-chat-row-keys'
import { MobileNativeChatScrollHold, mobileNativeChatRowId } from './MobileNativeChatScrollHold'
import { ToolRun } from './MobileNativeChatToolRun'

const platform = vi.hoisted(() => ({ OS: 'web' }))
// The page's own hold, as on iOS: where the browser has scroll anchoring it keeps these places
// itself, and the hold runs only for a regroup or a move to another row.
vi.stubGlobal('navigator', {
  userAgent:
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1'
})

vi.mock('react-native', async () => {
  const React = await import('react')
  // A class, so an opened run's box can scroll it the way it scrolls a real ScrollView.
  class ScrollView extends React.Component<{ children?: ReactNode }> {
    scrollToEnd = (): void => {}
    scrollTo = (): void => {}
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
// An earlier turn, then a reply working silently through 40 edits.
const chat = [say('u0', 'user', 'first'), say('x0', 'assistant', 'answer'), say('u1', 'user', 'go')]
  .concat({
    ...say('a1', 'assistant', 'On it'),
    blocks: [{ type: 'text', text: 'On it' }, edit(1)]
  })
  .concat(run(1).slice(1), ...Array.from({ length: 39 }, (_, i) => run(i + 2)))

type Box = { id: string; top: number; bottom: number; end: number }
type Element = {
  getAttribute: () => string
  getBoundingClientRect: () => { top: number; bottom: number }
  querySelectorAll: (selector: string) => Element[]
}

const oldHostTail = (): NativeChatMessage[] => JSON.parse(JSON.stringify(chat))
const from = (id: string) => oldHostTail().slice(chat.findIndex((m) => m.id === id))

/** The page with one 20-tall line per text, as the list's scrollable node counting its writes. */
function page(tree: () => Node | Node[] | null) {
  const boxes = (): Box[] => {
    const out: Box[] = []
    let y = 0
    const walk = (node: Node | string): void => {
      if (typeof node === 'string' || node.type === 'span') {
        y += typeof node === 'string' ? 0 : 20
        return
      }
      const at = out.push({ id: String(node.props.testID ?? ''), top: y, bottom: y, end: 0 }) - 1
      node.children?.forEach(walk)
      out[at] = { ...out[at]!, bottom: y, end: out.length }
    }
    walk({ type: 'page', props: {}, children: [tree() ?? []].flat() })
    return out
  }
  const select = (all: Box[], from: number, to: number, selector: string): Element[] => {
    const prefix = /\^="([^"]+)"/.exec(selector)?.[1] ?? '?'
    return all.flatMap((box, at) =>
      at >= from && at < to && box.id.startsWith(prefix)
        ? [
            {
              getAttribute: () => box.id,
              getBoundingClientRect: () => ({
                top: box.top - node.scrollTop,
                bottom: box.bottom - node.scrollTop
              }),
              querySelectorAll: (inner: string) => select(all, at + 1, box.end, inner)
            }
          ]
        : []
    )
  }
  let scrollTop = 0
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
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    querySelectorAll: (selector: string): Element[] => select(boxes(), 0, Infinity, selector),
    top: (id: string): number =>
      (boxes().find((box) => box.id === id)?.top ?? Number.NaN) - node.scrollTop
  }
  return node
}

function Row({ message, rowKey }: { message: NativeChatMessage; rowKey: string }): ReactElement {
  const { prose, tools } = splitNativeChatBlocks(message.blocks)
  const words = prose.map((block, i) =>
    h('span', { key: i }, block.type === 'text' ? block.text : '')
  )
  const run =
    tools.length > 0 && h(ToolRun, { blocks: tools, defaultExpanded: false, expandChildren: false })
  return h('div', { testID: mobileNativeChatRowId(rowKey) }, words, run)
}

type Scroller = ReturnType<typeof page>

let shownKeys!: MobileNativeChatRowKeys

function Chat(props: {
  messages: NativeChatMessage[]
  following: boolean
  live: boolean
  listRef: { current: { getScrollableNode: () => Scroller } }
}): ReactElement {
  const folded = useMemo(
    () => foldMobileNativeChatMessages(props.messages, 'claude'),
    [props.messages]
  )
  const keys = useMobileNativeChatRowKeys(folded, props.messages, 'chat')
  shownKeys = keys
  return h(
    Fragment,
    null,
    h(MobileNativeChatScrollHold, {
      rowKeys: keys,
      isFollowing: () => props.following,
      listRef: props.listRef
    }),
    h('div', { testID: 'header' }, h('span', null, 'Load earlier')),
    folded.map((item) =>
      h(Row, { key: keys.keyOf(item), message: item, rowKey: keys.keyOf(item) })
    ),
    props.live ? h('span', null, 'Working') : null
  )
}

function mount(messages: NativeChatMessage[], options = { following: false, live: false }) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(h('div'))
  })
  const scroller = page(() => renderer.toJSON())
  const listRef = { current: { getScrollableNode: () => scroller } }
  const show = (next: NativeChatMessage[]): number => {
    const before = scroller.writes
    act(() => renderer.update(h(Chat, { ...options, messages: next, listRef })))
    return scroller.writes - before
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
  return { scroller, show, press, drawn, lines, find, rows }
}

it('keeps the line a reader was on, its run open, when older messages join the run from an old host', () => {
  // On a line inside the run, or at the top beside Load earlier while the window opens on a result
  // that the run's older calls take in.
  for (const atTop of [false, true]) {
    const chat0 = mount(from('r31'))
    chat0.press(mobileNativeChatRowId('a32'))
    chat0.press('chat-member:call:c34')
    const opened = chat0.lines('chat-member:call:c34')
    chat0.scroller.scrollTop += chat0.scroller.top('chat-member:call:c34')
    // An old host ignores the cursor and sends the whole tail again: new objects, the same ids.
    for (const [older, first] of [
      ['r21', 'c32'],
      ['u0', 'c22']
    ] as const) {
      if (atTop) {
        chat0.scroller.scrollTop = 0
      }
      const line = `chat-member:call:${atTop ? first : 'c34'}`
      const top = chat0.scroller.top(line)
      expect(chat0.show(from(older))).toBeLessThanOrEqual(1)
      expect(chat0.scroller.top(line)).toBe(top)
    }

    // The run keeps its row, so the earlier turn sits above it and the run stays open.
    expect(chat0.rows().slice(0, 3)).toEqual(['u0', 'x0', 'u1'].map(mobileNativeChatRowId))
    expect(chat0.lines('chat-member:call:c34')).toBe(opened)
    expect(chat0.drawn('chat-member:call:c1')).toBe(1)
    // The result row the window opened on is now drawn by the run.
    expect(shownKeys.current('r21')).toBe('a32')

    // A reply and a send land after the run: what the reader had loaded stays drawn.
    chat0.show([...oldHostTail(), say('done', 'assistant', 'Done'), say('ask', 'user', 'next')])
    expect(chat0.drawn(mobileNativeChatRowId('a32'))).toBe(1)
    expect(chat0.drawn('chat-member:call:c34')).toBe(1)
  }

  // The rows after the run stay put: collapsed, its header holds where it was, not in the result
  // row's place; open, the line on screen holds while older calls join the run above it.
  const later = Array.from({ length: 10 }, (_, i) => say(`t${i}`, 'user', 'later'))
  for (const open of [false, true]) {
    const tail = mount([...from('r21'), ...later])
    if (open) {
      tail.press(mobileNativeChatRowId('a22'))
      tail.scroller.scrollTop += tail.scroller.top('chat-member:call:c27') + 40
    }
    const before = tail.scroller.top(mobileNativeChatRowId('t0'))
    tail.show([...oldHostTail(), ...later])
    expect(tail.scroller.top(mobileNativeChatRowId('t0'))).toBe(before)
  }
})

it('leaves the view to iOS while it bounces the list past the top, and to a native list', () => {
  for (const [os, scrollTop] of [
    ['web', -15],
    ['ios', 40]
  ] as const) {
    platform.OS = os
    const chat0 = mount(from('r21'))
    chat0.press(mobileNativeChatRowId('a22'))
    chat0.scroller.scrollTop = scrollTop
    expect(chat0.show(oldHostTail())).toBe(0)
  }
  platform.OS = 'web'
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
    chat0.scroller.scrollTop = options.following ? chat0.scroller.scrollHeight - 200 : 50
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

  // Trims split the top run: sequential calls leave a result above it; parallel calls (each call,
  // then each output, or all outputs in one message) leave results below it. Results never take
  // the run's key.
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
    top.scroller.scrollTop = top.scroller.top('chat-member:call:c6') + top.scroller.scrollTop - 10
    const trim = (trimmed: number) => {
      top.show([...source.slice(trimmed), ...rows, say(`done${trimmed}`, 'assistant', 'Done')])
      const run = top.find(mobileNativeChatRowId(head))
      expect(run.findAll((n) => n.props.testID === 'chat-member:call:c6')).toHaveLength(1)
      expect(top.scroller.top('chat-member:call:c6')).toBe(10)
    }
    trim(1)
    expect(top.drawn(mobileNativeChatRowId(orphan))).toBe(1)
    // A second single trim, then two at once.
    trim(2)
    trim(4)
    // Paging back folds every result that was split off into the run again.
    top.show([...source, ...rows, say('done4', 'assistant', 'Done')])
    expect(absorbed.map(shownKeys.current)).toEqual(absorbed.map(() => head))
    // Once its last call leaves, the run is gone; its outputs don't take its key.
    top.show([...source.slice(last), ...rows, say('done', 'assistant', 'Done')])
    expect(top.drawn(mobileNativeChatRowId(head))).toBe(0)
  }

  // A trim takes the very line the reader is on: the next one keeps its place.
  const reader = mount([...chat.slice(3, 15), ...rows])
  reader.press(mobileNativeChatRowId('a1'))
  reader.scroller.scrollTop += reader.scroller.top('chat-member:call:c1')
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
  // The roster first on screen: an older sibling joining moves it up to that sibling's place.
  chat0.scroller.scrollTop = 20
  const below = tops(['new0', 'new5'])
  expect(chat0.show(all)).toBeLessThanOrEqual(1)
  expect(tops(['new0', 'new5'])).toEqual(below)
  expect(chat0.drawn(mobileNativeChatRowId('s2'))).toBe(1)
  // And back: a trim of the first sibling moves the roster down to the second's place.
  chat0.scroller.scrollTop += chat0.scroller.top(mobileNativeChatRowId('s2'))
  const after = tops(['mid0', 'mid5'])
  expect(chat0.show(all.slice(13))).toBeLessThanOrEqual(1)
  expect(tops(['mid0', 'mid5'])).toEqual(after)
  expect(chat0.drawn(mobileNativeChatRowId('s2'))).toBe(1)
})
