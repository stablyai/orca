import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { buildMobileNativeChatTransientData } from './mobile-native-chat-render-data'
import { projectMobileNativeChatRows } from './mobile-native-chat-row-projection'
import {
  useMobileNativeChatRowProps,
  type MobileNativeChatRowLookups
} from './use-mobile-native-chat-row-props'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

function message(id: string, text = id): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

const turn: MobileNativeChatTurnRow = {
  turnStatus: null,
  turnExpanded: false,
  activeTurnIsWorking: false,
  trailingRun: false,
  userMessageOpen: false,
  onToggleUserMessage: () => {},
  mayStillGrow: false,
  reasoningIsLive: false,
  reasoningExpanded: false,
  onToggleReasoning: () => {},
  onToggleSubagentGroup: () => {}
}
const lookups: MobileNativeChatRowLookups = {
  resolveTurnRow: () => turn,
  rowKeyOf: (row) => row.id,
  runOwners: new Map(),
  taskListPredecessors: new Map(),
  unsentNotices: new Map(),
  receipts: null,
  actionablePromptIds: undefined
}

let renderer: ReactTestRenderer | null = null
let projection: ReturnType<typeof useMobileNativeChatRowProps>
function Harness({ args }: { args: Parameters<typeof useMobileNativeChatRowProps> }) {
  projection = useMobileNativeChatRowProps(...args)
  return null
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})
function show(scope: string, rows: NativeChatMessage[], props = lookups) {
  act(() => {
    const element = createElement(Harness, { args: [rows, props, scope] })
    if (renderer) {
      renderer.update(element)
    } else {
      renderer = create(element)
    }
  })
}

it('keeps transient updates, ordering and removal visible while reusing equal rows', () => {
  const source = [message('image')]
  const batch = (preview = 'photo', pending = 'next', seconds = 4) =>
    buildMobileNativeChatTransientData({
      messages: source,
      folded: source,
      streaming: null,
      imagePreviewsByMessageId: { image: [preview] },
      pending: [{ id: 'pending', text: pending }]
    }).data.map((row) => ({ message: row, turnStatus: { workedSeconds: seconds } }))
  const before = projectMobileNativeChatRows(batch())
  expect(projectMobileNativeChatRows(batch(), before)).toBe(before)
  for (const rows of [batch('changed'), batch('photo', 'edited'), batch('photo', 'next', 9)]) {
    expect(projectMobileNativeChatRows(rows, before)).not.toBe(before)
  }
  const reversed = projectMobileNativeChatRows(batch().toReversed(), before)
  expect(reversed.rows).toEqual(before.rows.toReversed())
  const removed = projectMobileNativeChatRows([reversed.rows[0]!], reversed)
  expect(removed.byId.has('image')).toBe(false)
  expect(projectMobileNativeChatRows(batch(), removed).rows[0]).not.toBe(before.rows[0])
})

it('skips candidate derivation only while every source identity and scope is unchanged', () => {
  const rows = [
    { ...message('a'), unsent: true as const },
    { ...message('b'), shortened: true as const }
  ]
  const resolve = vi.fn(() => ({ ...turn, workRun: rows }))
  const detail = {
    raw: vi.fn((id: string) => rows.find((row) => row.id === id)),
    state: vi.fn((): 'available' | 'partial' => 'available'),
    load: async () => {}
  }
  const source = { client: stubRpcClient(), sessionId: 'session', messageDetail: detail }
  let props: MobileNativeChatRowLookups = {
    ...lookups,
    resolveTurnRow: resolve,
    itemSource: source
  }
  show('chat', rows, props)
  const before = projection
  resolve.mockClear()
  detail.raw.mockClear()
  detail.state.mockClear()
  show('chat', rows, { ...props })
  expect(projection).toBe(before)
  expect(resolve).not.toHaveBeenCalled()
  expect(detail.raw).not.toHaveBeenCalled()
  expect(detail.state).not.toHaveBeenCalled()
  const derive = (next = props, messages = rows, scope = 'chat') => {
    resolve.mockClear()
    show(scope, messages, next)
    expect(resolve).toHaveBeenCalledTimes(rows.length)
    props = next
  }
  derive(props, [...rows])
  derive(props, rows, 'other-chat')
  derive()
  for (const key of ['runOwners', 'taskListPredecessors', 'unsentNotices', 'receipts'] as const) {
    derive({ ...props, [key]: new Map() })
  }
  derive({ ...props, rowKeyOf: (row) => row.id })
  derive({ ...props, actionablePromptIds: ['b'] })
  expect(projection.rows[1]?.awaiting).toBe(true)
  derive({
    ...props,
    unsentNotices: new Map([['a', 'Not sent']]),
    runOwners: new Map([['b', 'a']])
  })
  expect(projection.rows[0]?.unsentNotice).toBe('Not sent')
  expect(projection.rows[1]?.runOwner).toBe('a')
  detail.raw = vi.fn((id: string) => rows.find((row) => row.id === id))
  derive()
  detail.state = vi.fn(() => 'partial')
  derive()
  expect(projection.rows[0]?.itemSource?.details).toContainEqual({
    id: 'b',
    raw: rows[1],
    state: 'partial'
  })
  detail.load = vi.fn(detail.load)
  derive()
  source.client = stubRpcClient()
  derive()
  source.sessionId = 'replacement'
  derive()
  source.messageDetail = { ...detail }
  derive()
  derive({ ...props, itemSource: { ...source } })
  const changedResolver = vi.fn(() => ({ ...turn, reasoningExpanded: true, workRun: rows }))
  show('chat', rows, { ...props, resolveTurnRow: changedResolver })
  expect(changedResolver).toHaveBeenCalledTimes(rows.length)
  expect(projection.rows[0]).toMatchObject({ reasoningExpanded: true, workRun: rows })
  show('other-chat', rows)
  expect(projection.rows[0]).not.toBe(before.rows[0])
  expect(projection.rows[0]?.unsentNotice).toBeUndefined()
})
