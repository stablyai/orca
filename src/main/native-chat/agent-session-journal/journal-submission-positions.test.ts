// Each submission carries where the journal wrote its row. A rejected send's own row moves to its
// rejection, so this is the only journal-order record of where it was sent. Derived on every fold: a
// replay of the same rows gives the same value, and a history page carries it. A rejection a turn's
// end made also names that turn.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { readAgentSessionHydrationPage } from '../agent-session-wire/agent-session-history-page'
import { createTrackedJournalOpener } from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'look around' }]
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

/** A send accepted for later handover, handed over, then taken back. */
async function sendHandedOverThenWithdrawn() {
  root = await mkdtemp(join(tmpdir(), 'orca-submission-positions-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const submitted = await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: 'send-1',
    body: BODY,
    fence: 1,
    handoverRecorded: true
  })
  const handedOver = await journal.resolveDispatch({
    clientMessageId: 'send-1',
    state: 'pending',
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const pending = { ...journal.submission('send-1') }
  const withdrawn = await journal.resolveDispatch({
    clientMessageId: 'send-1',
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
    fence: 1,
    recovered: true
  })
  return { journal, submitted, handedOver, pending, withdrawn }
}

const TURN = {
  provider: 'legacy',
  agent: 'codex',
  sessionId: 'session-1',
  recordId: 'turn-lifecycle:turn-1'
} as const

/** A send its turn ended without taking: the rejection names that turn. */
async function sendWithdrawnByItsTurnEnd() {
  root = await mkdtemp(join(tmpdir(), 'orca-submission-positions-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: 'send-1',
    body: BODY,
    fence: 1
  })
  await journal.resolveDispatch({
    clientMessageId: 'send-1',
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
    answeredInTurn: { turn: TURN, via: 'start' },
    fence: 1
  })
  return journal
}

describe('the turn a rejected submission was answered into', () => {
  it('is the turn record its rejection named, on the snapshot, a replay, and the page', async () => {
    const journal = await sendWithdrawnByItsTurnEnd()
    const turnItemId = agentJournalItemKey(TURN)

    expect(journal.submission('send-1')).toMatchObject({
      dispatchState: 'rejected',
      answeredInTurn: { turnItemId, via: 'start' }
    })
    expect(readAgentSessionHydrationPage(journal).submissions).toEqual([
      expect.objectContaining({ answeredInTurn: { turnItemId, via: 'start' } })
    ])
    await journals.closeAll()
    const replayed = await journals.open({ identity: IDENTITY, stateDirectory: root! })
    expect(replayed.submission('send-1')).toMatchObject({
      answeredInTurn: { turnItemId, via: 'start' }
    })
  })

  it('is stated as none on a take-back that names no turn, so it reads apart from an older row', async () => {
    const { journal } = await sendHandedOverThenWithdrawn()

    expect(journal.submission('send-1')).toMatchObject({
      dispatchState: 'rejected',
      answeredInTurn: null
    })
    expect(readAgentSessionHydrationPage(journal).submissions[0]).toMatchObject({
      answeredInTurn: null
    })
  })
})

describe("a submission's journal position", () => {
  it('is its own row, which a take-back does not move', async () => {
    const { journal, submitted, handedOver, pending, withdrawn } =
      await sendHandedOverThenWithdrawn()

    expect(pending).toMatchObject({ submittedSequence: submitted.sequence })
    expect(handedOver.sequence).toBeGreaterThan(submitted.sequence)
    expect(journal.submission('send-1')).toMatchObject({
      dispatchState: 'rejected',
      submittedSequence: submitted.sequence
    })
    // Anti-vacuous: the send's own row moved to its rejection, so only this field says where it was sent.
    expect(
      journal.snapshot().items.find((item) => item.itemId === agentJournalSubmissionKey('send-1'))
        ?.sequence
    ).toBe(withdrawn.sequence)
  })

  it('comes back the same from a replay of the stored rows', async () => {
    const { journal, submitted } = await sendHandedOverThenWithdrawn()
    await journals.closeAll()

    const replayed = await journals.open({ identity: IDENTITY, stateDirectory: root! })

    expect(replayed.submission('send-1')).toMatchObject({ submittedSequence: submitted.sequence })
    expect(journal).not.toBe(replayed)
  })

  it('reaches a client on the history page', async () => {
    const { journal, submitted } = await sendHandedOverThenWithdrawn()

    expect(readAgentSessionHydrationPage(journal).submissions).toEqual([
      expect.objectContaining({ clientMessageId: 'send-1', submittedSequence: submitted.sequence })
    ])
  })
})
