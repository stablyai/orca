// Through the real chat host: the bot's adds in one turn are one chat row; adds in two turns stay two.
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { projectStructuredAgentSessionMessages } from '../../shared/agent-session/view/structured-agent-session-message-projection'
import { createStructuredQuestionProjection } from '../../shared/native-chat/transcript/messages/structured-agent-question-projection'
import { projectStructuredOrcaCardItem } from '../../shared/structured-automation-saved-projection'
import { nativeChatTurnMembership } from '../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import { foldBotItemNotes } from '../../shared/bots/bot-item-note-runs'
import type { BotItemNoteEntry } from '../../shared/bots/bot-item-note'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { appendBotItemNote } from './bot-item-chat-notes'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function turnIdentity(id: string): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: THREAD, turnId: `turn-of-${id}`, ordinal: 0 }
}

async function setTurn(id: string, state: 'running' | 'completed'): Promise<void> {
  await journal().appendItem(
    turnIdentity(id),
    {
      kind: 'turn',
      turnId: `turn-of-${id}`,
      state,
      startedAt: NOW,
      ...(state === 'completed' ? { completedAt: NOW, outcome: 'success' as const } : {}),
      userItemId: agentJournalSubmissionKey(id)
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** A turn the owner's prompt opened, running. */
async function runningTurn(): Promise<string> {
  const id = await rig.workingSend()
  await setTurn(id, 'running')
  await rig.settleAccepted(id, id)
  return id
}

async function toolCall(turn: string, ordinal: number): Promise<void> {
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `turn-of-${turn}`, ordinal },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'orca bot item add' } }]
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turnIdentity(turn)) } }
  )
}

function add(uid: string): void {
  const entry: BotItemNoteEntry = { uid, number: 1, title: uid, status: 'planned', event: 'made' }
  appendBotItemNote(SESSION, {
    kind: 'bot-item-note',
    noteId: `note-${uid}`,
    by: 'bot',
    entries: [entry]
  })
}

/** The chat's rows as the desktop draws them: the shown item notes, each with its chips. */
async function drawnNotes(): Promise<string[][]> {
  const snapshot = (
    await (await rig.host.journalReads(SESSION)).operationWindow({ afterSequence: 0 })
  ).snapshot
  const messages = projectStructuredAgentSessionMessages(
    snapshot.items,
    [],
    snapshot.submissions,
    createStructuredQuestionProjection(projectStructuredOrcaCardItem).messages
  )
  const { turnKeys } = nativeChatTurnMembership(messages, {
    items: snapshot.items,
    submissions: snapshot.submissions
  })
  return foldBotItemNotes(messages, turnKeys).flatMap((message) =>
    message.botItemNote ? [message.botItemNote.entries.map((entry) => entry.uid)] : []
  )
}

async function notesWritten(count: number): Promise<void> {
  await eventually(async () =>
    expect(
      (
        await (await rig.host.journalReads(SESSION)).operationWindow({ afterSequence: 0 })
      ).snapshot.items.filter((item) => item.body.kind === 'bot-item-note')
    ).toHaveLength(count)
  )
}

it('draws the bot’s adds in one turn, between its tool calls, as one row', async () => {
  const turn = await runningTurn()
  await toolCall(turn, 1)
  add('item-1')
  await notesWritten(1)
  await toolCall(turn, 2)
  add('item-2')
  await notesWritten(2)

  expect(await drawnNotes()).toEqual([['item-1', 'item-2']])
})

it('keeps the bot’s adds in two turns apart', async () => {
  const first = await runningTurn()
  add('item-1')
  await notesWritten(1)
  await setTurn(first, 'completed')
  await runningTurn()
  add('item-2')
  await notesWritten(2)

  expect(await drawnNotes()).toEqual([['item-1'], ['item-2']])
})
