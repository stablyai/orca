import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { firstStructuredChatNamingPrompt } from '../../../shared/structured-chat-naming-eligibility'
import { structuredSessionGateFacts } from '../../runtime/orchestration/structured-session-pointer-delivery'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { hostTestMessage } from './structured-agent-session-host-test-data'
import {
  createAgentSessionCatchUpReader,
  readAgentSessionHistory
} from './agent-session-history-page'
import { readAgentSessionConversationOutline } from './agent-session-conversation-outline'
import { shortenedAgentJournalItem } from './agent-session-item-wire-form'

const IDENTITY = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread-1')
}
const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal
const item = (ordinal: number) => ({
  provider: 'codex' as const,
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal
})
const body = (text: string) => ({ ...hostTestMessage(text), role: 'assistant' as const })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-history-public-read-'))
  journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('refreshes a retained catch-up reader after a same-cursor disk reload', async () => {
  const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(item(0), { kind: 'turn', turnId: 'turn-1', state: 'running' }, options)
  const view = journal.publicRead()
  expect(view.snapshot.items).toHaveLength(1)
  const cursor = journal.cursor()
  const read = createAgentSessionCatchUpReader(journal, undefined, view)
  const request = {
    sessionId: IDENTITY.sessionId,
    direction: 'after' as const,
    cursor: { epoch: cursor.epoch, sequence: 0 }
  }
  expect(read(request)).toMatchObject({
    ok: true,
    page: { items: [{ body: { state: 'running' } }], latestTurn: { turn: { state: 'running' } } }
  })
  openTestJournalHostDatabase(root)
    .db.prepare(
      "UPDATE journal_rows SET row_json = json_set(row_json, '$.body.state', 'completed') WHERE session_id = ? AND epoch = ? AND seq = ?"
    )
    .run(IDENTITY.sessionId, cursor.epoch, cursor.sequence)
  await journal.open()
  expect(journal.cursor()).toEqual(cursor)
  expect(read(request)).toMatchObject({
    ok: true,
    page: {
      items: [{ body: { state: 'completed' } }],
      latestTurn: { turn: { state: 'completed' } }
    }
  })
})

it('serves current detail, outline, naming and mail facts without changing later history', async () => {
  const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendSubmission({
    clientMessageId: 'u',
    payloadFingerprint: 'u',
    body: hostTestMessage('Name this'),
    fence: 1
  })
  const turn = await journal.appendItem(
    item(0),
    { kind: 'turn', turnId: 'turn-1', state: 'running' },
    options
  )
  const replies = { ...options, turnScope: { kind: 'turn' as const, turnItemId: turn.itemId } }
  await journal.appendItem(item(1), body('obsolete reply'), replies)
  await journal.appendItem(item(2), body('initial reply'), replies)
  const warm = journal.snapshot()
  await journal.resolveDispatch({
    clientMessageId: 'u',
    state: 'accepted',
    providerIdentity: null,
    fence: 1
  })
  await journal.appendItem(item(2), body('Revised reply'), replies)
  await journal.appendTombstone(item(1), { fence: 1 })
  await journal.appendItem(item(0), { kind: 'turn', turnId: 'turn-1', state: 'completed' }, options)
  const current = journal.snapshot()
  const expected = structuredClone(current)
  expect(current).not.toBe(warm)
  const detail = current.items.at(-1)!
  expect(shortenedAgentJournalItem(detail, 1024)?.body).toMatchObject({
    blocks: [{ text: 'Revised reply' }]
  })
  expect(readAgentSessionConversationOutline(current).entries).toMatchObject([
    { preview: 'Name this', reply: 'Revised reply' }
  ])
  expect(firstStructuredChatNamingPrompt(current, 0)).toBe('Name this')
  expect(structuredSessionGateFacts(current.items).turnRunning).toBe(false)
  expect(current.submissions).toMatchObject([{ clientMessageId: 'u', dispatchState: 'accepted' }])
  expect(
    readAgentSessionHistory(journal, { sessionId: IDENTITY.sessionId, direction: 'tail' })
  ).toMatchObject({
    ok: true,
    page: { items: expected.items, submissions: expected.submissions }
  })
  expect(journal.snapshot()).toEqual(expected)
})
