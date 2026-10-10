import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type {
  AgentJournalItemBody,
  AgentJournalTurnItem
} from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import {
  CursorJournalTranslator,
  cursorTurnIdentity,
  type CursorTurn
} from './cursor-structured-journal'

const TURN: CursorTurn = { sessionId: 'cursor_session', turnId: 'turn-1', startedAt: 1 }

function sink(): { events: StructuredAgentSessionEventSink; bodies: AgentJournalItemBody[] } {
  const bodies: AgentJournalItemBody[] = []
  return {
    bodies,
    events: {
      appendItem(_identity, body) {
        bodies.push(body)
      },
      appendTombstone() {},
      publish() {}
    }
  }
}

const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
})

describe('cursor turn revisions', () => {
  it('revises the turn after the send is accepted with no provider echo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-turn-'))
    try {
      const journal = await openCursorJournal(root)
      const settled = await acceptThenSettle(journal)
      expect(settled.revision).toBe(2)
      expect(
        journal.itemBody(agentJournalItemKey(cursorTurnIdentity('cursor_session', 'turn-1')))
      ).toMatchObject({ state: 'completed', outcome: 'success' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function openCursorJournal(root: string): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: 'cursor_session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'cursor',
      providerHandle: null
    },
    stateDirectory: root
  })
}

async function acceptThenSettle(journal: AgentSessionJournal): Promise<{ revision: number }> {
  await journal.appendSubmission({
    clientMessageId: 'turn-1',
    payloadFingerprint: 'fp-turn-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    fence: 1,
    handoverRecorded: true
  })
  const identity = cursorTurnIdentity('cursor_session', 'turn-1')
  const running: AgentJournalTurnItem = agentJournalTurnBody({
    turnId: 'turn-1',
    state: 'running',
    startedAt: 1,
    userItemId: 'user-1'
  })
  const completed: AgentJournalTurnItem = agentJournalTurnBody({
    turnId: 'turn-1',
    state: 'completed',
    outcome: 'success',
    startedAt: 1,
    completedAt: 2,
    userItemId: 'user-1'
  })
  await journal.appendItem(identity, running, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await journal.resolveDispatch({
    clientMessageId: 'turn-1',
    state: 'accepted',
    providerIdentity: null,
    fence: 1
  })
  return journal.appendItem(identity, completed, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

describe('CursorJournalTranslator', () => {
  it('records token use and the selected context window on the turn', () => {
    const captured = sink()
    const translator = new CursorJournalTranslator('cursor_session', captured.events)
    translator.setContextWindowTokens(1_000_000)
    translator.openTurn(TURN)
    translator.apply(TURN, {
      type: 'usage',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 17
    })
    const turn = captured.bodies.at(-1)
    expect(turn).toMatchObject({
      kind: 'turn',
      userItemId: agentJournalSubmissionKey('turn-1'),
      state: 'running',
      contextUsage: {
        used: {
          kind: 'estimate',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1
          }
        },
        window: { tokens: 1_000_000 }
      }
    })
  })

  it('keeps the usage after the turn settles', () => {
    const captured = sink()
    const translator = new CursorJournalTranslator('cursor_session', captured.events)
    translator.setContextWindowTokens(256_000)
    translator.openTurn(TURN)
    translator.apply(TURN, { type: 'result', status: 'finished', result: 'done' })
    translator.apply(TURN, {
      type: 'usage',
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 4
    })
    const turn = captured.bodies.at(-1)
    expect(turn).toMatchObject({
      kind: 'turn',
      state: 'completed',
      outcome: 'success',
      contextUsage: { window: { tokens: 256_000 } }
    })
  })
})
