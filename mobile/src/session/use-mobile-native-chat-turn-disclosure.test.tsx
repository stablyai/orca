import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../src/shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

import { Harness, Result, userMessage } from './use-mobile-native-chat-turn-disclosure.test-fixture'

describe('useMobileNativeChatTurnDisclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not scan bridge-lane transcripts', () => {
    const messages: NativeChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    const findLastIndex = vi.spyOn(messages, 'findLastIndex')
    const slice = vi.spyOn(messages, 'slice')
    const filter = vi.spyOn(messages, 'filter')
    const map = vi.spyOn(messages, 'map')

    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: false }))
    })

    expect(findLastIndex).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
    expect(map).not.toHaveBeenCalled()
  })

  it('keeps a settled turn handler stable for NUL-delimited scope keys', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages: NativeChatMessage[] = [
        {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'go' }],
          timestamp: null,
          source: 'transcript'
        }
      ]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      vi.setSystemTime(6_000)
      act(() => {
        renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
      })
      const first = renderer!.root.findByType(Result).props.disclosure.resolveRow(0, messages[0])

      const refreshed = [...messages]
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: refreshed, enabled: true, isWorking: false })
        )
      })
      const second = renderer!.root.findByType(Result).props.disclosure.resolveRow(0, refreshed[0])

      // The row carries the key; the handler itself lives on the hook and stays
      // stable for the scope, so a re-render never disturbs a row's memo.
      expect(first.turnKey).toBe('u1')
      expect(second.turnKey).toBe('u1')
      const firstHandler = renderer!.root.findByType(Result).props.disclosure.onToggleTurn
      expect(firstHandler).toBeTypeOf('function')
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: [...refreshed], enabled: true, isWorking: false })
        )
      })
      expect(renderer!.root.findByType(Result).props.disclosure.onToggleTurn).toBe(firstHandler)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the host-recorded duration over the locally observed one', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1')]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      // Locally this turn ran 5s; the host says 3m 17s and the host wins.
      vi.setSystemTime(6_000)
      const settledTurns = new Map([['u1', { startedAt: 500, workedSeconds: 197 }]])
      act(() => {
        renderer?.update(
          createElement(Harness, { messages, enabled: true, isWorking: false, settledTurns })
        )
      })
      const row = renderer!.root.findByType(Result).props.disclosure.resolveRow(0, messages[0])
      expect(row.turnStatus).toEqual({ startedAt: 500, thinking: false, workedSeconds: 197 })
      expect(row.turnKey).toBe('u1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the live bar on every render until it settles in place', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1')]
      const seen: unknown[] = []
      function Recorder({ isWorking }: { isWorking: boolean }): React.JSX.Element {
        const disclosure = useMobileNativeChatTurnDisclosure({
          messages,
          enabled: true,
          isWorking,
          scopeKey: 'host\0worktree\0tab-a'
        })
        seen.push(disclosure.resolveRow(0, messages[0]).turnStatus)
        return createElement('result', { disclosure })
      }
      act(() => {
        renderer = create(createElement(Recorder, { isWorking: true }))
      })
      vi.setSystemTime(6_000)
      seen.length = 0
      // No host duration for this turn: the settle is stamped locally, one pass later.
      act(() => {
        renderer?.update(createElement(Recorder, { isWorking: false }))
      })
      expect(seen).not.toContain(null)
      expect(seen.at(-1)).toEqual({ startedAt: 1_000, thinking: false, workedSeconds: 5 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses local duration when the host explicitly cannot verify the end', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1')]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      vi.setSystemTime(60_000)
      act(() => {
        renderer?.update(
          createElement(Harness, {
            messages,
            enabled: true,
            isWorking: false,
            settledTurns: new Map([['u1', null]])
          })
        )
      })
      const row = renderer!.root.findByType(Result).props.disclosure.resolveRow(0, messages[0])
      expect(row.turnStatus).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('keeps the live bar under the prompt that opened the running turn, not a mid-turn send', () => {
    const tool: NativeChatMessage = {
      id: 'tool-a',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Bash', input: { command: 'sleep 15' }, state: 'running' }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const messages = [userMessage('A'), tool, userMessage('B')]
    const user = (
      id: string,
      sequence: number,
      turnScope?: AgentJournalTurnScope
    ): AgentJournalRenderItem => ({
      itemId: id,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
      ...(turnScope ? { turnScope } : {})
    })
    const turn = (
      turnId: string,
      sequence: number,
      state: 'running' | 'interrupted',
      userItemId: string,
      turnScope?: AgentJournalTurnScope
    ): AgentJournalRenderItem => ({
      itemId: turnId,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: { kind: 'turn', turnId, state, userItemId },
      ...(turnScope ? { turnScope } : {})
    })
    const toolItem = (
      sequence: number,
      turnScope?: AgentJournalTurnScope
    ): AgentJournalRenderItem => ({
      itemId: 'tool-a',
      revision: 0,
      sequence,
      observedAt: sequence,
      body: {
        kind: 'tool-call',
        name: 'Bash',
        input: { command: 'sleep 15' },
        state: 'running'
      },
      ...(turnScope ? { turnScope } : {})
    })
    const rows = () => {
      const disclosure = renderer!.root.findByType(Result).props.disclosure
      return messages.map((message, index) => disclosure.resolveRow(index, message))
    }
    const render = (props: Parameters<typeof Harness>[0]) =>
      act(() => {
        if (renderer) {
          renderer.update(createElement(Harness, props))
        } else {
          renderer = create(createElement(Harness, props))
        }
      })

    it("on a host that states each row's turn, the steered message and the work are one live turn", () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(10_000)
        const t1 = { kind: 'turn', turnItemId: 't1' } as const
        const thread = { kind: 'thread' } as const
        // B was handed over while A's turn runs, so the host scopes it to that turn.
        const whileA = [
          user('A', 1, thread),
          turn('t1', 2, 'running', 'A', thread),
          toolItem(3, t1),
          user('B', 4, t1)
        ]
        render({
          messages,
          enabled: true,
          workingStartedAt: 5_000,
          turnJournal: { items: whileA, submissions: [] }
        })
        let [rowA, rowTool, rowB] = rows()
        expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: null })
        expect(rowB.turnStatus).toBeNull()
        expect([rowA, rowTool, rowB].map((row) => row.activeTurnIsWorking)).toEqual([
          true,
          true,
          true
        ])

        // B's own turn opens: A takes the host's settled duration, B counts from A's end.
        const whileB = [
          user('A', 1, thread),
          turn('t1', 2, 'interrupted', 'A', thread),
          toolItem(3, t1),
          user('B', 4, t1),
          turn('t2', 5, 'running', 'B', thread)
        ]
        render({
          messages,
          enabled: true,
          workingStartedAt: 22_000,
          settledTurns: new Map([['A', { startedAt: 5_000, workedSeconds: 17 }]]),
          turnJournal: { items: whileB, submissions: [] }
        })
        ;[rowA, rowTool, rowB] = rows()
        expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: 17 })
        expect(rowB.turnStatus).toEqual({ startedAt: 22_000, thinking: false, workedSeconds: null })
        expect(rowB.activeTurnIsWorking).toBe(true)
        expect(rowTool.activeTurnIsWorking).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it("a queued card's Steer joins the running turn: no bar of its own, and live with it", () => {
      const t1 = { kind: 'turn', turnItemId: 't1' } as const
      const thread = { kind: 'thread' } as const
      // Steer hands the draft over under a fresh submission id while A's turn runs, so the host
      // scopes the row to that turn; the submission names the card it came from.
      const steerId = agentJournalSubmissionKey('hand-off-1')
      const steered = [userMessage('A'), tool, userMessage(steerId)]
      render({
        messages: steered,
        enabled: true,
        workingStartedAt: 5_000,
        turnJournal: {
          items: [
            user('A', 1, thread),
            turn('t1', 2, 'running', 'A', thread),
            toolItem(3, t1),
            user(steerId, 4, t1)
          ],
          submissions: [
            {
              clientMessageId: 'hand-off-1',
              queuedMessageId: 'draft-1',
              fence: 1,
              payloadFingerprint: 'fp',
              dispatchState: 'pending',
              providerItemId: null,
              reason: null,
              submittedAt: 4,
              resolvedAt: null
            }
          ]
        }
      })
      const disclosure = renderer!.root.findByType(Result).props.disclosure
      const [rowA, , rowSteer] = steered.map((message, index) =>
        disclosure.resolveRow(index, message)
      )
      expect(rowA.turnStatus).not.toBeNull()
      expect(rowSteer.turnStatus).toBeNull()
      expect(rowSteer.activeTurnIsWorking).toBe(true)
    })

    it('on a host that states no turn, the bar and liveness follow the running record by journal order', () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(10_000)
        const whileA = [user('A', 1), turn('t1', 2, 'running', 'A'), toolItem(3), user('B', 4)]
        render({
          messages,
          enabled: true,
          workingStartedAt: 5_000,
          turnJournal: { items: whileA, submissions: [] }
        })
        let [rowA, rowTool, rowB] = rows()
        expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: null })
        expect(rowB.turnStatus).toBeNull()
        // Liveness follows the owning turn: A's tool row stays live while B waits.
        expect(rowTool.activeTurnIsWorking).toBe(true)
        expect(rowB.activeTurnIsWorking).toBe(false)

        const whileB = [
          user('A', 1),
          turn('t1', 2, 'interrupted', 'A'),
          toolItem(3),
          user('B', 4),
          turn('t2', 5, 'running', 'B')
        ]
        render({
          messages,
          enabled: true,
          workingStartedAt: 22_000,
          settledTurns: new Map([['A', { startedAt: 5_000, workedSeconds: 17 }]]),
          turnJournal: { items: whileB, submissions: [] }
        })
        ;[rowA, , rowB] = rows()
        expect(rowA.turnStatus).toEqual({ startedAt: 5_000, thinking: false, workedSeconds: 17 })
        expect(rowB.turnStatus).toEqual({ startedAt: 22_000, thinking: false, workedSeconds: null })
      } finally {
        vi.useRealTimers()
      }
    })
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
        const [, rowB, rowW2] = messages.map((message, index) =>
          disclosure.resolveRow(index, message)
        )
        // The first visible row carries the bar after earlier activity folds away.
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

  it('keeps at most the latest 128 turns expanded', () => {
    vi.useFakeTimers()
    try {
      let messages: NativeChatMessage[] = []
      for (let index = 0; index < 129; index++) {
        messages = messages.concat(userMessage(`u${index}`))
        vi.setSystemTime(index * 2_000)
        act(() => {
          if (renderer) {
            renderer.update(createElement(Harness, { messages, enabled: true }))
          } else {
            renderer = create(createElement(Harness, { messages, enabled: true }))
          }
        })
        vi.setSystemTime(index * 2_000 + 1_000)
        act(() => {
          renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
        })
        const disclosureNow = renderer!.root.findByType(Result).props.disclosure
        const row = disclosureNow.resolveRow(index, messages[index])
        act(() => disclosureNow.onToggleTurn(row.turnKey))
      }

      const disclosure = renderer!.root.findByType(Result).props.disclosure
      const expanded = messages.filter(
        (message, index) => disclosure.resolveRow(index, message).turnExpanded
      )
      expect(expanded).toHaveLength(128)
      expect(disclosure.resolveRow(0, messages[0]).turnExpanded).toBe(false)
      expect(disclosure.resolveRow(128, messages[128]).turnExpanded).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a turn the provider opened live while it runs, and the turn before it settled', () => {
    let sequence = 0
    const entry = (
      itemId: string,
      body: AgentJournalItemBody,
      turnScope: AgentJournalTurnScope = { kind: 'thread' }
    ): AgentJournalRenderItem => {
      sequence += 1
      return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
    }
    const said = (itemId: string, turnItemId: string) =>
      entry(
        itemId,
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: itemId }] },
        { kind: 'turn', turnItemId }
      )
    const items = [
      entry('u1', { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }),
      entry('t1', { kind: 'turn', turnId: 't1', state: 'completed', userItemId: 'u1' }),
      said('a1', 't1'),
      entry('wake', { kind: 'turn', turnId: 'wake', state: 'running', userItemId: 'claude:wake' }),
      said('wake-note', 'wake')
    ]
    const messages: NativeChatMessage[] = ['u1', 'a1', 'wake-note'].map((id, index) => ({
      ...userMessage(id),
      role: index === 0 ? 'user' : 'assistant'
    }))
    act(() => {
      renderer = create(
        createElement(Harness, {
          messages,
          enabled: true,
          settledTurns: new Map([['u1', { startedAt: 500, workedSeconds: 4 }]]),
          turnJournal: { items, submissions: [] }
        })
      )
    })
    const disclosure = renderer!.root.findByType(Result).props.disclosure
    const rows = messages.map((message, index) => disclosure.resolveRow(index, message))
    expect(rows.map((row) => row.activeTurnIsWorking)).toEqual([false, false, true])
    expect(rows[0].turnStatus?.workedSeconds).toBe(4)
  })

  it('draws the live bar on a turn whose record and opening message are not loaded', () => {
    // The newest rows of a long turn; its record is above the page, named only by the host.
    const items: AgentJournalRenderItem[] = ['a300', 'a301'].map((itemId, index) => ({
      itemId,
      revision: 0,
      sequence: 300 + index,
      observedAt: 300 + index,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: itemId }] },
      turnScope: { kind: 'turn', turnItemId: 'turn-record' }
    }))
    const messages: NativeChatMessage[] = items.map((item) => ({
      ...userMessage(item.itemId),
      role: 'assistant'
    }))
    const rowsWith = (latestTurn: NativeChatTurnJournal['latestTurn']) => {
      act(() => {
        renderer = create(
          createElement(Harness, {
            messages,
            enabled: true,
            workingStartedAt: 1_000,
            turnJournal: { items, submissions: [], latestTurn }
          })
        )
      })
      const disclosure = renderer!.root.findByType(Result).props.disclosure
      const rows = messages.map((message, index) => disclosure.resolveRow(index, message))
      act(() => renderer?.unmount())
      return rows
    }

    const hosted = rowsWith({
      itemId: 'turn-record',
      observedAt: 1,
      turn: { turnId: 'turn-1', state: 'running', startedAt: 1_000, userItemId: 'user-1' }
    })
    expect(hosted[0]?.turnStatus).toMatchObject({ startedAt: 1_000 })
    expect(hosted.map((row) => row.activeTurnIsWorking)).toEqual([true, true])

    // From the loaded rows alone, nothing names the turn, so no bar draws.
    expect(rowsWith(undefined).map((row) => row.turnStatus)).toEqual([null, null])
  })
})

describe('the open reasoning block the live line discloses', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const block = (id: string, state: 'running' | 'completed'): NativeChatMessage => ({
    id,
    role: 'reasoning',
    blocks: [{ type: 'text', text: `${id} weighs two approaches` }],
    timestamp: null,
    source: 'transcript',
    state
  })
  const show = (
    messages: NativeChatMessage[],
    props: { thinking?: boolean; lineYields?: boolean }
  ) =>
    act(() => {
      const element = createElement(Harness, { messages, enabled: true, ...props })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  const latest = () => renderer!.root.findByType(Result).props.disclosure

  it('hides only that block, and lands it open once it ends if the reader opened it live', () => {
    const prompt = userMessage('u1')
    show([prompt, block('r-1', 'running')], { thinking: true })
    expect(latest().liveLine).toMatchObject({
      reasoning: { message: { id: 'r-1' } },
      reasoningExpanded: false
    })
    expect(latest().resolveRow(1, block('r-1', 'running')).reasoningIsLive).toBe(true)
    act(() => latest().onToggleReasoning('reasoning:r-1'))
    expect(latest().liveLine.reasoningExpanded).toBe(true)

    // Closed while the turn works on: the line discloses nothing, and the row draws open.
    show([prompt, block('r-1', 'completed')], { thinking: false })
    expect(latest().liveLine).toMatchObject({ reasoning: null })
    const row = latest().resolveRow(1, block('r-1', 'completed'))
    expect(row).toMatchObject({ reasoningIsLive: false, reasoningExpanded: true })

    // The next block starts collapsed.
    show([prompt, block('r-1', 'completed'), block('r-2', 'running')], { thinking: true })
    expect(latest().liveLine).toMatchObject({
      reasoning: { message: { id: 'r-2' } },
      reasoningExpanded: false
    })
  })

  it('discloses nothing, and hides nothing, while a prompt takes the line', () => {
    show([userMessage('u1'), block('r-1', 'running')], { thinking: true, lineYields: true })
    expect(latest().liveLine).toBeNull()
    expect(latest().resolveRow(1, block('r-1', 'running')).reasoningIsLive).toBe(false)
  })
})
