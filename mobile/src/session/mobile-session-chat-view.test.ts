import { describe, expect, it } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import {
  advanceChatViewProcessFence,
  chatPairTargetForView,
  chatViewLeafIds,
  hostChatPairForRow,
  ownerlessChatDisplayLeaf,
  resolveMobileLeafView,
  type MobileChatViewInputs,
  type MobileChatViewRow
} from './mobile-session-chat-view'

const split: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'A' },
  second: { type: 'leaf', leafId: 'B' }
}
const sole: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'A' }

function row(overrides: Partial<MobileChatViewRow> = {}): MobileChatViewRow {
  return {
    type: 'terminal',
    id: 'P::A',
    parentTabId: 'P',
    leafId: 'A',
    parentLayout: { root: sole },
    ...overrides
  }
}

const chatDefault: MobileChatViewInputs = {
  defaultView: { value: 'chat', settled: true },
  readability: 'readable'
}

function view(
  target: MobileChatViewRow,
  inputs: MobileChatViewInputs = chatDefault,
  rows: MobileChatViewRow[] = [target]
) {
  return resolveMobileLeafView(
    target,
    hostChatPairForRow(target),
    chatViewLeafIds(target, rows),
    inputs
  )
}

describe('resolveMobileLeafView (A1c-1)', () => {
  it('shows an explicit chat on its owner and terminal on every sibling', () => {
    const layout = { root: split, chatLeafId: 'B' }
    expect(view(row({ viewMode: 'chat', parentLayout: layout }))).toBe('terminal')
    expect(view(row({ id: 'P::B', leafId: 'B', viewMode: 'chat', parentLayout: layout }))).toBe(
      'chat'
    )
  })

  it('shows an ownerless chat only on the display leaf its caller resolved, never claiming it', () => {
    expect(view(row({ viewMode: 'chat' }))).toBe('terminal')
    const placed = { viewMode: 'chat' as const, chatLeafId: 'A' }
    expect(resolveMobileLeafView(row({ viewMode: 'chat' }), placed, ['A'], chatDefault)).toBe(
      'chat'
    )
  })

  it('treats an owner outside the tree as a closed chat pane: terminal, and no survivor claims it', () => {
    const survivor = row({
      viewMode: 'chat',
      launchAgent: 'claude',
      parentLayout: { root: sole, chatLeafId: 'gone' }
    })
    expect(view(survivor)).toBe('terminal')
  })

  it('keeps an explicit terminal even when this device defaults to chat', () => {
    expect(view(row({ viewMode: 'terminal', launchAgent: 'claude' }))).toBe('terminal')
  })

  it('opens an unswitched sole leaf launched as a supported agent in this device default', () => {
    expect(view(row({ launchAgent: 'claude' }))).toBe('chat')
    expect(
      view(row({ launchAgent: 'claude' }), {
        defaultView: { value: 'terminal', settled: true },
        readability: 'readable'
      })
    ).toBe('terminal')
  })

  it('keeps every other unswitched tab terminal', () => {
    // No launch hint: a Terminal-started agent stays terminal whatever its status says.
    expect(view(row())).toBe('terminal')
    expect(view(row({ launchAgent: 'not-an-agent' }))).toBe('terminal')
    expect(view(row({ launchAgent: 'claude', parentLayout: { root: split } }))).toBe('terminal')
  })

  it('waits on an unsettled default instead of guessing', () => {
    expect(
      view(row({ launchAgent: 'claude' }), {
        defaultView: { value: 'terminal', settled: false },
        readability: 'readable'
      })
    ).toBe('undecided')
  })

  it('gates transcript-gated agents on settled readability', () => {
    const grok = row({ launchAgent: 'grok' })
    const at = (readability: MobileChatViewInputs['readability']) =>
      view(grok, { defaultView: { value: 'chat', settled: true }, readability })
    expect(at('readable')).toBe('chat')
    expect(at('unknown')).toBe('undecided')
    expect(at('unreadable')).toBe('terminal')
    expect(at('failed')).toBe('terminal')
  })

  it('never reads live agent status', () => {
    const withStatus = { ...row(), agentStatus: { agentType: 'claude', state: 'working' } }
    expect(view(withStatus)).toBe('terminal')
  })

  it('falls back to sibling rows when the snapshot carries no layout', () => {
    const a = row({ parentLayout: undefined, launchAgent: 'claude' })
    const b = row({ id: 'P::B', leafId: 'B', parentLayout: undefined })
    expect(chatViewLeafIds(a, [a, b])).toEqual(['A', 'B'])
    expect(view(a, chatDefault, [a, b])).toBe('terminal')
    expect(view(a, chatDefault, [a])).toBe('chat')
  })
})

describe('ownerlessChatDisplayLeaf (R1-F1)', () => {
  const canShow = (leaves: string[]) => (leafId: string) => leaves.includes(leafId)
  const settledOn = (leafId: string) => ({ leafId, settled: true })

  it('takes the sole or active leaf only when that leaf can show chat now', () => {
    const at = (args: Partial<Parameters<typeof ownerlessChatDisplayLeaf>[0]>) =>
      ownerlessChatDisplayLeaf({
        shown: null,
        leafIds: ['A', 'B'],
        activeLeafId: 'B',
        canShowChat: canShow(['A', 'B']),
        ...args
      })
    expect(at({ leafIds: ['A'], activeLeafId: null })).toEqual(settledOn('A'))
    expect(at({})).toEqual(settledOn('B'))
    expect(at({ canShowChat: canShow(['A']) })).toBeNull()
    expect(at({ activeLeafId: null })).toBeNull()
    expect(at({ activeLeafId: 'gone' })).toBeNull()
    // R2a-F2: a gated agent waiting on readability holds the leaf, unsettled.
    expect(at({ canShowChat: () => 'unknown' })).toEqual({ leafId: 'B', settled: false })
  })

  it('stays on the leaf it shows while that leaf exists, whatever is active or eligible now', () => {
    const shownOnA = { shown: 'A', activeLeafId: 'B', canShowChat: canShow([]) }
    expect(ownerlessChatDisplayLeaf({ ...shownOnA, leafIds: ['A', 'B'] })).toEqual(settledOn('A'))
    expect(ownerlessChatDisplayLeaf({ ...shownOnA, leafIds: ['B'] })).toBeNull()
  })
})

describe('chatPairTargetForView', () => {
  it('names the pressed leaf for chat, and no leaf for terminal', () => {
    const a = row({ parentLayout: { root: split } })
    expect(chatPairTargetForView(a, 'chat')).toEqual({ viewMode: 'chat', chatLeafId: 'A' })
    expect(chatPairTargetForView(a, 'terminal')).toEqual({ viewMode: 'terminal' })
  })
})

describe('advanceChatViewProcessFence (R2-F2, R4-n1)', () => {
  const advance = (
    before: Parameters<typeof advanceChatViewProcessFence>[0],
    next: Partial<MobileChatViewRow>
  ) => advanceChatViewProcessFence(before, row(next))

  it('compares incarnations when both sides have one, else PTY ids', () => {
    const main = { ptyId: 'pty-1', incarnationId: 'inc-1' }
    expect(advance(main, { ptyId: 'pty-1' }).changed).toBe(false)
    expect(advance(main, { ptyId: 'pty-2' }).changed).toBe(true)
    expect(advance(main, { ptyId: 'pty-1', incarnationId: 'inc-2' }).changed).toBe(true)
    expect(
      advance({ ptyId: 'pty-1', incarnationId: null }, { ptyId: 'pty-1', incarnationId: 'inc-1' })
        .changed
    ).toBe(false)
  })

  it('treats an empty id as unknown and carries the last known one forward', () => {
    const missing = advance({ ptyId: 'pty-1', incarnationId: null }, { ptyId: null })
    expect(missing).toEqual({ fence: { ptyId: 'pty-1', incarnationId: null }, changed: false })
    expect(advance(missing.fence, { ptyId: '' }).changed).toBe(false)
    expect(advance(missing.fence, { ptyId: 'pty-2' }).changed).toBe(true)
    expect(advance(undefined, { ptyId: 'pty-1' }).changed).toBe(false)
  })
})
