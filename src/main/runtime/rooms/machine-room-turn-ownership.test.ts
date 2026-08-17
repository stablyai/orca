import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurn
} from '../../../shared/agent-session-journal-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../shared/structured-agent-session-reducer'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../../native-chat/agent-session-journal/journal-reducer'
import {
  buildJournalItemRow,
  buildJournalSubmissionRow
} from '../../native-chat/agent-session-journal/journal-row-builders'
import { journalDispatchRowBuilder } from '../../native-chat/agent-session-journal/journal-row-builders'
import { parseJournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import { roomStructuredLifecycle } from './machine-harness-session'

describe('Rooms journal turn ownership', () => {
  it.each(['codex', 'claude'] as const)(
    'isolates adjacent %s turns without losing actual steer or the root placeholder',
    (agent) => {
      const state = createJournalReducerState('session', 'epoch')
      let seq = 0
      const body = (text: string, role: 'user' | 'assistant' = 'user') => ({
        kind: 'message' as const,
        role,
        blocks: [{ type: 'text' as const, text }]
      })
      const append = (
        identity: AgentJournalItemIdentity,
        value: Parameters<typeof buildJournalItemRow>[0]['body']
      ) => {
        const row = buildJournalItemRow({
          state,
          identity,
          body: value,
          seq: ++seq,
          ts: seq * 1000,
          fence: 1
        })
        const parsed = parseJournalRow(JSON.stringify(row))
        expect(parsed.ok).toBe(true)
        if (parsed.ok) {
          applyJournalRow(state, parsed.row)
        }
      }
      const lifecycle = (turnId: string, status: 'running' | 'completed') =>
        append(
          { provider: 'legacy', agent, sessionId: 'session', recordId: `turn-lifecycle:${turnId}` },
          {
            kind: 'status',
            text: status,
            turnLifecycle: {
              turnId,
              state: status,
              ...(status === 'completed' ? { outcome: 'completed' as const } : {})
            }
          }
        )
      const submit = (id: string, turn: AgentJournalTurn) => {
        applyJournalRow(
          state,
          buildJournalSubmissionRow({
            state,
            clientMessageId: id,
            body: body(id),
            payloadFingerprint: id,
            providerHandle: { kind: 'opaque', agent, value: 'provider' },
            seq: ++seq,
            ts: seq * 1000,
            fence: 1
          })
        )
        const providerIdentity: AgentJournalItemIdentity =
          agent === 'codex' && turn.root
            ? { provider: 'codex', threadId: 'thread', turnId: turn.turnId, ordinal: 0 }
            : { provider: 'legacy', agent, sessionId: 'session', recordId: `user:${id}`, turn }
        applyJournalRow(
          state,
          journalDispatchRowBuilder(() => state, {
            clientMessageId: id,
            state: 'accepted',
            providerIdentity,
            fence: 1
          })(++seq, seq * 1000)
        )
      }
      submit('old-root', { turnId: 'old', root: true })
      lifecycle('old', 'running')
      submit('old-steer', { turnId: 'old' })
      lifecycle('old', 'completed')
      submit('new-root', { turnId: 'new', root: true })
      lifecycle('new', 'running')
      expect(
        roomStructuredLifecycle({
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          items: renderJournalState(state).items.filter((item) => item.itemId !== 'orca:new-root')
        })?.messages
      ).toEqual([])
      append(
        {
          provider: 'legacy',
          agent,
          sessionId: 'session',
          recordId: 'comment',
          turn: { turnId: 'new' }
        },
        body('Again sleep 50', 'assistant')
      )
      const observe = () =>
        roomStructuredLifecycle({
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          items: renderJournalState(state).items
        })!
      expect(observe().messages.map((message) => message.role)).toEqual(['assistant'])
      submit('new-steer', { turnId: 'new' })
      expect(observe().userMessage).toEqual({ id: 'new', text: 'new-steer' })
      expect(observe().messages.filter((message) => message.role === 'user')).toHaveLength(1)
      lifecycle('new', 'completed')
      expect(observe().messages).toHaveLength(2)
      expect(observe().timestamp).toBe(seq * 1000)
      expect(state.items.get('orca:new-root')?.body.kind).toBe('message')
      const withoutRoot = renderJournalState(state).items.filter(
        (item) => item.itemId !== 'orca:new-root'
      )
      expect(
        roomStructuredLifecycle({
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          items: withoutRoot
        })?.messages.filter((message) => message.role === 'user')
      ).toHaveLength(1)
      expect(
        state.aliases.has(
          agentJournalItemKey({
            provider: 'legacy',
            agent,
            sessionId: 'session',
            recordId: 'turn-lifecycle:new'
          })
        )
      ).toBe(false)
    }
  )
})
