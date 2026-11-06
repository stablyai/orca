import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnJournal } from '../../../../../src/shared/native-chat/transcript/native-chat-turn-membership'

import { Harness, Result } from './use-mobile-native-chat-turn-disclosure.test-fixture'

describe('useMobileNativeChatTurnDisclosure with a turn journal', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  // Allow missing scopes to exercise legacy-host journal ordering.
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

  // Journal B’s send while A still works, then open B after A’s remaining tools/answer so membership cannot follow message order alone.
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
          ['a-tool-1', undefined, false],
          ['a-tool-2', undefined, false],
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
