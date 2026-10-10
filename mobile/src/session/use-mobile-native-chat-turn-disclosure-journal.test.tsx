import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'

import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

describe('useMobileNativeChatTurnDisclosure with a turn journal', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  /** A journal of `entries` in order, each naming the turn it belongs to (null for none). With
   *  `statesScope` false the rows carry no scope, as an older host writes them. */
  function journalOf(
    entries: readonly [itemId: string, body: AgentJournalItemBody, turnItemId: string | null][],
    statesScope: boolean
  ): NativeChatTurnJournal {
    return {
      items: entries.map(([itemId, body, turnItemId], index) => ({
        itemId,
        revision: 0,
        sequence: index + 1,
        observedAt: index + 1,
        body,
        ...(statesScope
          ? {
              turnScope: turnItemId
                ? { kind: 'turn' as const, turnItemId }
                : { kind: 'thread' as const }
            }
          : {})
      })),
      submissions: []
    }
  }
  const said = (role: 'user' | 'assistant'): AgentJournalItemBody => ({
    kind: 'message',
    role,
    blocks: []
  })
  const record = (
    turnId: string,
    state: 'running' | 'completed',
    userItemId: string
  ): AgentJournalItemBody => ({ kind: 'turn', turnId, state, userItemId })
  const hosts = [
    ['states each row’s turn', true],
    ['states no scope', false]
  ] as const

  it.each(hosts)(
    "keeps a running turn's rows live across a mid-turn send the host folded in, on a host that %s",
    (_host, statesScope) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(10_000)
        const tool = (id: string): NativeChatMessage => ({
          id,
          role: 'assistant',
          blocks: [
            { type: 'tool-call', name: 'Bash', input: { command: 'sleep 15' }, state: 'running' }
          ],
          timestamp: null,
          source: 'transcript'
        })
        // The #23621 shape: B lands mid-turn and the tool rows after it are still A's.
        const messages = [userMessage('A'), tool('t1'), userMessage('B'), tool('t2')]
        const turnJournal = journalOf(
          [
            ['A', said('user'), null],
            ['tA', record('tA', 'running', 'A'), null],
            ['t1', said('assistant'), 'tA'],
            ['B', said('user'), 'tA'],
            ['t2', said('assistant'), 'tA']
          ],
          statesScope
        )
        act(() => {
          renderer = create(
            createElement(Harness, {
              messages,
              enabled: true,
              workingStartedAt: 5_000,
              turnJournal
            })
          )
        })
        const disclosure = renderer!.root.findByType(Result).props.disclosure
        const [rowA, rowT1, rowB, rowT2] = messages.map((message, index) =>
          disclosure.resolveRow(index, message)
        )
        expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: null })
        // The steered bubble shares A's turn but never carries a bar of its own.
        expect(rowB.turnStatus).toBeNull()
        expect(rowT1.activeTurnIsWorking).toBe(true)
        expect(rowT2.activeTurnIsWorking).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(hosts)(
    "anchors a provider-opened turn's bar above its first row, on a host that %s",
    (_host, statesScope) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(10_000)
        const woke: NativeChatMessage = {
          id: 'woke',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Woke up.' }],
          timestamp: null,
          source: 'transcript'
        }
        const messages = [userMessage('u1'), woke]
        const turnJournal = journalOf(
          [
            ['u1', said('user'), null],
            ['wake', record('wake', 'completed', 'claude:wake'), null],
            ['woke', said('assistant'), 'wake']
          ],
          statesScope
        )
        act(() => {
          renderer = create(
            createElement(Harness, {
              messages,
              enabled: true,
              isWorking: false,
              settledTurns: new Map([['wake', { startedAt: 5_000, workedSeconds: 9 }]]),
              turnJournal
            })
          )
        })
        const disclosure = renderer!.root.findByType(Result).props.disclosure
        const [rowU1, rowWoke] = messages.map((message, index) =>
          disclosure.resolveRow(index, message)
        )
        expect(rowU1.turnStatus).toBeNull()
        expect(rowWoke.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: 9 })
        expect(rowWoke.turnStatusAbove).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(hosts)(
    "never hands a provider-opened turn's clock to a message sent during it, on a host that %s",
    (_host, statesScope) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(10_000)
        const row = (id: string): NativeChatMessage => ({
          id,
          role: 'assistant',
          blocks: [{ type: 'text', text: id }],
          timestamp: null,
          source: 'transcript'
        })
        // A wake turn runs; B is sent during it and folded in, so B opened nothing.
        const messages = [row('w1'), userMessage('B'), row('w2')]
        const journal = (state: 'running' | 'completed') =>
          journalOf(
            [
              ['wake', record('wake', state, 'claude:wake'), null],
              ['w1', said('assistant'), 'wake'],
              ['B', said('user'), 'wake'],
              ['w2', said('assistant'), 'wake']
            ],
            statesScope
          )
        act(() => {
          renderer = create(
            createElement(Harness, {
              messages,
              enabled: true,
              workingStartedAt: 5_000,
              turnJournal: journal('running'),
              settledTurns: new Map([['wake', null]])
            })
          )
        })
        // The wake turn settles: the host no longer names a running turn.
        vi.setSystemTime(20_000)
        act(() => {
          renderer!.update(
            createElement(Harness, {
              messages,
              enabled: true,
              isWorking: false,
              workingStartedAt: null,
              turnJournal: journal('completed'),
              settledTurns: new Map([['wake', { startedAt: 5_000, workedSeconds: 15 }]])
            })
          )
        })
        const disclosure = renderer!.root.findByType(Result).props.disclosure
        const [rowW1, rowB, rowW2] = messages.map((message, index) =>
          disclosure.resolveRow(index, message)
        )
        expect(rowW1.turnStatus).toBeNull()
        expect(rowB.turnStatus).toBeNull()
        expect(rowW2.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: 15 })
      } finally {
        vi.useRealTimers()
      }
    }
  )

  // Claude runs A; B is sent mid-turn and Claude answers it after A. The journal writes B when it
  // is sent, so A's remaining tool run and its answer follow B there, and B's turn opens after them.
  it.each(hosts)(
    "draws A's remaining rows under A's bar, then B's bubble and turn, on a host that %s",
    (_host, statesScope) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(30_000)
        const message = (id: string, role: 'user' | 'assistant'): NativeChatMessage => ({
          id,
          role,
          blocks: [{ type: 'text', text: id }],
          timestamp: null,
          source: 'transcript'
        })
        const messages = [
          message('A', 'user'),
          message('a-tool-1', 'assistant'),
          message('B', 'user'),
          message('a-tool-2', 'assistant'),
          message('FIRST DONE', 'assistant'),
          message('b-answer', 'assistant')
        ]
        const turnJournal = journalOf(
          [
            ['A', said('user'), null],
            ['tA', record('tA', 'completed', 'A'), null],
            ['a-tool-1', said('assistant'), 'tA'],
            // Handed over while A runs, so the host scopes it to A's turn until its own opens.
            ['B', said('user'), 'tA'],
            ['a-tool-2', said('assistant'), 'tA'],
            ['FIRST DONE', said('assistant'), 'tA'],
            ['tB', record('tB', 'running', 'B'), null],
            ['b-answer', said('assistant'), 'tB']
          ],
          statesScope
        )
        act(() => {
          renderer = create(
            createElement(Harness, {
              messages,
              enabled: true,
              workingStartedAt: 29_000,
              settledTurns: new Map([['A', { startedAt: 5_000, workedSeconds: 17 }]]),
              turnJournal
            })
          )
        })
        const disclosure = renderer!.root.findByType(Result).props.disclosure
        const list: NativeChatMessage[] = disclosure.listMessages
        const drawn = list.map((entry, index) => {
          const row = disclosure.resolveRow(index, entry)
          return [entry.id, row.turnStatus?.workedSeconds, row.activeTurnIsWorking]
        })
        expect(drawn).toEqual([
          ['A', 17, false],
          ['FIRST DONE', undefined, false],
          ['B', null, true],
          ['b-answer', undefined, true]
        ])
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
