import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../src/shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  DisclosureResult,
  Harness,
  userMessage
} from './use-mobile-native-chat-turn-disclosure.test-support'

describe('useMobileNativeChatTurnDisclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
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
      const disclosure = renderer!.root.findByType(DisclosureResult).props.disclosure
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
      const disclosure = renderer!.root.findByType(DisclosureResult).props.disclosure
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
})
