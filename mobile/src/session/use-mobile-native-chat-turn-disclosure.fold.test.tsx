import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

const message = (
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks']
): NativeChatMessage => ({ id, role, blocks, timestamp: null, source: 'transcript' })
const said = (role: NativeChatMessage['role']): AgentJournalItemBody => ({
  kind: 'message',
  role,
  blocks: []
})
const journal = (
  entries: readonly [string, AgentJournalItemBody, string | null][]
): NativeChatTurnJournal => ({
  items: entries.map(([itemId, body, turnItemId], index) => ({
    itemId,
    revision: 0,
    sequence: index + 1,
    observedAt: index + 1,
    body,
    turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
  })),
  submissions: []
})
const turn = (turnId: string, userItemId: string): AgentJournalItemBody => ({
  kind: 'turn',
  turnId,
  state: 'completed',
  userItemId
})
const runningTurn = (turnId: string, userItemId: string): AgentJournalItemBody => ({
  kind: 'turn',
  turnId,
  state: 'running',
  userItemId
})

function Harness({
  messages,
  turnJournal,
  settledKey = 'u1',
  isWorking = false,
  thinking = false,
  scopeKey = 'host\0worktree\0tab-a'
}: {
  messages: readonly NativeChatMessage[]
  turnJournal: NativeChatTurnJournal
  settledKey?: string
  isWorking?: boolean
  thinking?: boolean
  scopeKey?: string
}): React.JSX.Element {
  const disclosure = useMobileNativeChatTurnDisclosure({
    messages,
    enabled: true,
    isWorking,
    thinking,
    settledTurns: new Map([[settledKey, { startedAt: 1, workedSeconds: 2 }]]),
    turnJournal,
    scopeKey
  })
  return createElement(Host, { disclosure })
}

function Host({
  disclosure
}: {
  disclosure: ReturnType<typeof useMobileNativeChatTurnDisclosure>
}) {
  void disclosure
  return null
}

describe('useMobileNativeChatTurnDisclosure settled folding', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('folds settled work, toggles it with the turn caret, and isolates a new session scope', () => {
    const messages = [
      message('u1', 'user', [{ type: 'text', text: 'go' }]),
      message('reasoning', 'reasoning', [{ type: 'text', text: 'thinking' }]),
      message('answer', 'assistant', [{ type: 'text', text: 'done' }])
    ]
    const turnJournal = journal([
      ['u1', said('user'), null],
      ['t1', turn('t1', 'u1'), null],
      ['reasoning', said('assistant'), 't1'],
      ['answer', said('assistant'), 't1']
    ])
    act(() => {
      renderer = create(createElement(Harness, { messages, turnJournal }))
    })
    const ids = () =>
      renderer!.root
        .findByType(Host)
        .props.disclosure.listMessages.map((item: NativeChatMessage) => item.id)
    let disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(ids()).toEqual(['u1', 'answer'])
    act(() => disclosure.onToggleTurn('u1'))
    expect(ids()).toEqual(['u1', 'reasoning', 'answer'])
    act(() =>
      renderer!.update(
        createElement(Harness, { messages, turnJournal, scopeKey: 'host\0worktree\0tab-b' })
      )
    )
    expect(ids()).toEqual(['u1', 'answer'])
    disclosure = renderer!.root.findByType(Host).props.disclosure
    act(() => disclosure.onToggleTurn('u1'))
    expect(ids()).toEqual(['u1', 'reasoning', 'answer'])
    act(() => disclosure.onToggleTurn('u1'))
    expect(ids()).toEqual(['u1', 'answer'])
  })

  it('keeps a running reasoning turn visible beside a folded completed turn', () => {
    const messages = [
      message('u1', 'user', [{ type: 'text', text: 'first' }]),
      message('old-reasoning', 'reasoning', [{ type: 'text', text: 'finished work' }]),
      message('answer', 'assistant', [{ type: 'text', text: 'done' }]),
      message('u2', 'user', [{ type: 'text', text: 'second' }]),
      message('live-reasoning', 'reasoning', [{ type: 'text', text: 'currently thinking' }])
    ]
    const turnJournal = journal([
      ['u1', said('user'), null],
      ['t1', turn('t1', 'u1'), null],
      ['old-reasoning', said('assistant'), 't1'],
      ['answer', said('assistant'), 't1'],
      ['u2', said('user'), null],
      ['t2', runningTurn('t2', 'u2'), null],
      ['live-reasoning', said('reasoning'), 't2']
    ])
    act(() => {
      renderer = create(
        createElement(Harness, { messages, turnJournal, isWorking: true, thinking: true })
      )
    })
    let disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages.map((item: NativeChatMessage) => item.id)).toEqual([
      'u1',
      'answer',
      'u2',
      'live-reasoning'
    ])
    expect(disclosure.liveLine).toMatchObject({
      reasoning: { message: { id: 'live-reasoning' } },
      reasoningExpanded: false
    })

    act(() => disclosure.onToggleReasoning('reasoning:live-reasoning'))
    disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.liveLine.reasoningExpanded).toBe(true)
    expect(disclosure.listMessages.map((item: NativeChatMessage) => item.id)).toEqual([
      'u1',
      'answer',
      'u2',
      'live-reasoning'
    ])

    act(() => disclosure.onToggleTurn('u1'))
    disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages.map((item: NativeChatMessage) => item.id)).toEqual([
      'u1',
      'old-reasoning',
      'answer',
      'u2',
      'live-reasoning'
    ])
    expect(disclosure.liveLine.reasoningExpanded).toBe(true)
  })

  it('keeps failure and compaction reports while folding tool work', () => {
    const messages = [
      message('u1', 'user', [{ type: 'text', text: 'go' }]),
      message('tool', 'assistant', [
        { type: 'tool-call', name: 'Bash', input: { command: 'true' }, state: 'completed' }
      ]),
      message('failure', 'system', [{ type: 'text', text: 'failed', tone: 'error' }]),
      message('compact', 'system', [
        { type: 'text', text: 'compacted', presentation: 'compaction' }
      ])
    ]
    const turnJournal = journal([
      ['u1', said('user'), null],
      ['t1', turn('t1', 'u1'), null],
      ['tool', said('assistant'), 't1'],
      ['failure', said('system'), 't1'],
      ['compact', said('system'), 't1']
    ])
    act(() => {
      renderer = create(createElement(Harness, { messages, turnJournal }))
    })
    const disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages.map((item: NativeChatMessage) => item.id)).toEqual([
      'u1',
      'failure',
      'compact'
    ])
  })

  it('folds a settled turn with no prose to its user anchor', () => {
    const messages = [
      message('u1', 'user', [{ type: 'text', text: 'go' }]),
      message('tool', 'assistant', [
        { type: 'tool-call', name: 'Bash', input: { command: 'true' }, state: 'completed' }
      ])
    ]
    const turnJournal = journal([
      ['u1', said('user'), null],
      ['t1', turn('t1', 'u1'), null],
      ['tool', said('assistant'), 't1']
    ])
    act(() => {
      renderer = create(createElement(Harness, { messages, turnJournal }))
    })
    const disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages.map((item: NativeChatMessage) => item.id)).toEqual(['u1'])
    expect(disclosure.listMessages[0].blocks).toEqual(messages[0].blocks)
  })

  it('keeps a hidden carrier and caret for a settled history turn without its user row', () => {
    const messages = [
      message('tool', 'assistant', [
        { type: 'tool-call', name: 'Bash', input: { command: 'true' }, state: 'completed' }
      ])
    ]
    const turnJournal = journal([
      ['t1', turn('t1', 'missing-user'), null],
      ['tool', said('assistant'), 't1']
    ])
    act(() => {
      renderer = create(createElement(Harness, { messages, turnJournal, settledKey: 't1' }))
    })
    const disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages.map((item: NativeChatMessage) => item.id)).toEqual(['tool'])
    const row = disclosure.resolveRow(0, messages[0])
    expect(row.turnKey).toBe('t1')
    expect(row.turnStatus?.workedSeconds).toBe(2)
    expect(row.turnStatusAbove).toBe(true)
  })

  it('hides an orphan reasoning carrier while folded and restores it when expanded', () => {
    const original = message('reasoning', 'reasoning', [{ type: 'text', text: 'old thought' }])
    const messages = [original]
    const turnJournal = journal([
      ['t1', turn('t1', 'missing-user'), null],
      ['reasoning', said('reasoning'), 't1']
    ])
    act(() => {
      renderer = create(createElement(Harness, { messages, turnJournal, settledKey: 't1' }))
    })
    let disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages).toHaveLength(1)
    expect(disclosure.listMessages[0].blocks).toEqual([])
    act(() => disclosure.onToggleTurn('t1'))
    disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages[0].blocks).toEqual(original.blocks)
    act(() => disclosure.onToggleTurn('t1'))
    disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages[0].blocks).toEqual([])
  })

  it('does not clear a compaction-only carrier', () => {
    const compact = message('compact', 'system', [
      { type: 'text', text: 'compacted', presentation: 'compaction' }
    ])
    const turnJournal = journal([
      ['t1', turn('t1', 'missing-user'), null],
      ['compact', said('system'), 't1']
    ])
    act(() => {
      renderer = create(
        createElement(Harness, { messages: [compact], turnJournal, settledKey: 't1' })
      )
    })
    const disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages[0].blocks).toEqual(compact.blocks)
  })

  it('does not clear an outliving-task-only carrier', () => {
    const outlive = message('task', 'assistant', [
      {
        type: 'background-task',
        taskId: 'b1',
        kind: 'command',
        label: 'job',
        state: 'done'
      }
    ])
    const turnJournal = journal([
      ['t1', turn('t1', 'missing-user'), null],
      ['task', said('assistant'), 't1']
    ])
    act(() => {
      renderer = create(
        createElement(Harness, { messages: [outlive], turnJournal, settledKey: 't1' })
      )
    })
    const disclosure = renderer!.root.findByType(Host).props.disclosure
    expect(disclosure.listMessages[0].blocks).toEqual(outlive.blocks)
  })
})
