import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { AgentJournalRenderItem } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatTurnJournal } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

type Disclosure = ReturnType<typeof useMobileNativeChatTurnDisclosure>

const start = Date.parse('2026-11-27T12:00:00Z')
const at = (seconds: number): number => start + seconds * 1000
const call: NativeChatMessage['blocks'][number] = { type: 'tool-call', name: 'read', input: {} }

const row = (id: string, role: 'user' | 'assistant', seconds: number, text?: string) =>
  ({
    id,
    role,
    source: 'transcript',
    timestamp: at(seconds),
    blocks: text ? [{ type: 'text', text }] : [call]
  }) satisfies NativeChatMessage

// The person's prompt, work, two messages they sent into the running turn, more work after each.
const steered: NativeChatMessage[] = [
  row('ask', 'user', 0, 'Scan the release.'),
  row('read-1', 'assistant', 5),
  row('follow-up', 'user', 374, 'Debug deeply.'),
  row('read-2', 'assistant', 380),
  row('again', 'user', 400, 'Also check the logs.'),
  row('read-3', 'assistant', 410)
]

// Every row in one turn record, which the prompt opened; the later messages steer into it.
function journal(
  messages: readonly NativeChatMessage[],
  state: 'running' | 'completed'
): NativeChatTurnJournal {
  const items = messages.map(
    (message, index) =>
      ({
        itemId: message.id,
        revision: 0,
        sequence: index + 2,
        observedAt: message.timestamp!,
        turnScope: { kind: 'turn', turnItemId: 'turn-1' },
        body: { kind: 'message', role: message.role, blocks: message.blocks }
      }) as AgentJournalRenderItem
  )
  const record = {
    itemId: 'turn-1',
    revision: 0,
    sequence: 1,
    observedAt: start,
    turnScope: { kind: 'thread' },
    body: { kind: 'turn', turnId: 'turn-1', state, userItemId: 'ask', startedAt: start }
  } as AgentJournalRenderItem
  return { items: [record, ...items], submissions: [] }
}

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function disclose(
  messages: readonly NativeChatMessage[],
  { running, turnKey = 'ask' }: { running: boolean; turnKey?: string }
): () => Disclosure {
  let latest: Disclosure | null = null
  function Probe(): null {
    latest = useMobileNativeChatTurnDisclosure({
      messages,
      enabled: true,
      isWorking: running,
      workingStartedAt: start,
      settledTurns: running ? null : new Map([[turnKey, { startedAt: start, workedSeconds: 600 }]]),
      turnJournal: journal(messages, running ? 'running' : 'completed'),
      activityText: 'Reading 3 files',
      scopeKey: 'chat'
    })
    return null
  }
  act(() => {
    tree = create(createElement(Probe))
  })
  return () => latest!
}

function rowsOf(turns: Disclosure) {
  return turns.listMessages.map((message, index) => ({
    id: message.id,
    ...turns.resolveRow(index, message)
  }))
}

/** Each bar row's label facts, by the row it draws under. */
function bars(turns: Disclosure) {
  return Object.fromEntries(
    rowsOf(turns).flatMap(({ id, turnStatus, turnLeadStatus }) =>
      turnStatus
        ? [
            [
              id,
              {
                workedSeconds: turnStatus.workedSeconds,
                continued: turnStatus.continued === true,
                ...(turnLeadStatus && { lead: turnLeadStatus.workedSeconds })
              }
            ]
          ]
        : []
    )
  )
}

const folded = (turns: Disclosure) =>
  rowsOf(turns).flatMap(({ id, foldedAway }) => (foldedAway ? [id] : []))

function openEveryBar(read: () => Disclosure): void {
  for (const { turnKey, turnStatus, turnExpanded } of rowsOf(read())) {
    if (turnStatus && turnKey && !turnExpanded) {
      act(() => read().onToggleTurn(turnKey))
    }
  }
}

describe('a turn the person wrote into mid-turn', () => {
  it('while running: the first stretch freezes, finished ones continue, the live bar is under the newest message', () => {
    const turns = disclose(steered, { running: true })()

    expect(bars(turns)).toEqual({
      ask: { workedSeconds: 374, continued: false },
      'follow-up': { workedSeconds: 26, continued: true },
      again: { workedSeconds: null, continued: false }
    })
    expect(rowsOf(turns).find(({ id }) => id === 'again')!.turnStatus!.startedAt).toBe(at(400))
  })

  it('once settled: the whole turn on top, and each stretch under its message sums to it', () => {
    const turns = disclose(steered, { running: false })()

    expect(bars(turns)).toEqual({
      ask: { workedSeconds: 600, continued: false },
      'follow-up': { workedSeconds: 26, continued: true },
      again: { workedSeconds: 200, continued: true }
    })
  })

  it.each([true, false])(
    'folds each stretch on its own, and every tool call is one tap away (running: %s)',
    (running) => {
      const read = disclose(steered, { running })
      const hidden = running ? ['read-1', 'read-2'] : ['read-1', 'read-2', 'read-3']
      expect(folded(read())).toEqual(hidden)

      const followUp = rowsOf(read()).find(({ id }) => id === 'follow-up')!
      act(() => read().onToggleTurn(followUp.turnKey!))
      expect(folded(read())).toEqual(hidden.filter((id) => id !== 'read-2'))

      openEveryBar(read)
      expect(folded(read())).toEqual([])
    }
  )

  it("draws the turn's bar above its first loaded row when that is the person's message", () => {
    const tail = steered.slice(2)
    const turns = disclose(tail, { running: false, turnKey: 'turn-1' })()

    expect(bars(turns)).toEqual({
      'follow-up': { workedSeconds: 26, continued: true, lead: 600 },
      again: { workedSeconds: 200, continued: true }
    })
  })
})
