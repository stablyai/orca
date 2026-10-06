// A submission that hands off a queued draft names that draft (`queuedMessageId`),
// persisted on its journal row and published on the submission; a direct send
// names none. Clients read the link, never a draft id compared with a submission id.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-schemas'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { createJournalReducerState, applyJournalRow } from './journal-reducer'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import {
  agentSessionJournalProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-q',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}
const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'queued text' }]
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => ++clock,
    mintEpoch: () => `epoch-${clock}`
  })
}

async function handOff(journal: AgentSessionJournal, draftId: string, submissionId: string) {
  await journal.queuedMessages.insert({
    messageId: draftId,
    body: BODY,
    fingerprint: 'fp',
    hostInstance: 'p',
    source: { kind: 'user' }
  })
  await journal.appendSubmission(
    { clientMessageId: submissionId, payloadFingerprint: 'fp', body: BODY, fence: 0 },
    { messageId: draftId, expect: 'waiting', settledByOp: null }
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-link-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the submission names the queued draft it hands off', () => {
  it('on every hand-off, and never on a direct send', async () => {
    const journal = await open()
    await handOff(journal, 'draft-1', 'handoff-1')
    await journal.appendSubmission({
      clientMessageId: 'direct-1',
      payloadFingerprint: 'fp-direct',
      body: BODY,
      fence: 0
    })
    expect(journal.submission('handoff-1')?.queuedMessageId).toBe('draft-1')
    expect(journal.submission('direct-1')).not.toHaveProperty('queuedMessageId')
  })

  it('survives a reload, which replays the rows through the reducer', async () => {
    let journal = await open()
    await handOff(journal, 'draft-1', 'handoff-1')
    await journal.close()
    journal = await open()
    expect(journal.submission('handoff-1')?.queuedMessageId).toBe('draft-1')
    expect(
      journal.snapshot().submissions.find((entry) => entry.clientMessageId === 'handoff-1')
    ).toMatchObject({ queuedMessageId: 'draft-1' })
  })

  it('refuses a caller naming a different draft than the one it consumes, and writes nothing', async () => {
    const journal = await open()
    await journal.queuedMessages.insert({
      messageId: 'draft-1',
      body: BODY,
      fingerprint: 'fp',
      hostInstance: 'p',
      source: { kind: 'user' }
    })
    await expect(
      journal.appendSubmission(
        {
          clientMessageId: 'handoff-1',
          payloadFingerprint: 'fp',
          body: BODY,
          fence: 0,
          queuedMessageId: 'draft-2'
        },
        { messageId: 'draft-1', expect: 'waiting', settledByOp: null }
      )
    ).rejects.toThrow()
    expect(journal.submissions()).toHaveLength(0)
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })

  it('is published: the wire schema keeps the field rather than stripping it', async () => {
    const journal = await open()
    await handOff(journal, 'draft-1', 'handoff-1')
    const published = AgentJournalSubmissionSchema.parse(journal.submission('handoff-1'))
    expect(published.queuedMessageId).toBe('draft-1')
  })
})

describe('the persisted row', () => {
  const row: JournalRow = {
    v: 1,
    kind: 'submission',
    epoch: 'epoch-1',
    seq: 1,
    fence: 0,
    ts: 1,
    clientMessageId: 'handoff-1',
    payloadFingerprint: 'fp',
    providerHandle: agentSessionJournalProviderHandle(IDENTITY),
    body: BODY,
    queuedMessageId: 'draft-1'
  }

  it('parses with the key, which a reader that does not know it simply keeps', () => {
    const parsed = parseJournalRow(serializeJournalRow(row))
    expect(parsed).toMatchObject({ ok: true, row: { queuedMessageId: 'draft-1' } })
  })

  it('keeps a row whose stored link is malformed, dropping only the link', () => {
    const parsed = parseJournalRow(JSON.stringify({ ...row, queuedMessageId: 42 }))
    if (!parsed.ok) {
      throw new Error('the row must survive a malformed link')
    }
    const state = createJournalReducerState('session-q', 'epoch-1')
    applyJournalRow(state, parsed.row)
    expect(state.submissions.get('handoff-1')).not.toHaveProperty('queuedMessageId')
  })
})
