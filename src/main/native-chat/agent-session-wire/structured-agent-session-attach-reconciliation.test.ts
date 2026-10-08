// Attach is where the restart reconciler runs. These cover the wiring itself:
// that the sampled window reaches the journal, and that what it settles stops
// being reported unconfirmed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { digestPayload } from '../agent-session-journal/journal-payload-bounds'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { PlacedProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  attachJournal,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { sampleProviderHistoryWindow } from './structured-agent-session-history-sample'

const RECORD = agentSessionRecordFixture()

const PARAMS = {
  envelope: {
    sessionId: RECORD.sessionId,
    clientOperationId: 'op-1',
    expectedRuntimeFence: RECORD.lease.runtimeFence,
    payloadFingerprint: 'fp'
  },
  location: RECORD.location,
  provider: 'claude',
  agent: 'claude',
  accountHome: RECORD.accountHome,
  runtimeKind: 'native'
} as unknown as AgentSessionAttachParams

const IDENTITY = journalIdentityFor(RECORD, PARAMS)
const SESSION_ID = 'provider-session-alpha-1'

let root: string
const journals = createTrackedJournalOpener()

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

/** Read from the resume point the record's own owner set before the crashed send went out. */
function window(overrides: Partial<PlacedProviderHistoryWindow> = {}): PlacedProviderHistoryWindow {
  return {
    items: [],
    boundaryConsistent: true,
    turnInFlight: false,
    start: { fence: RECORD.lease.runtimeFence, movedAt: 0 },
    ...overrides
  }
}

/** A previous process wrote the submission row and died before its outcome. */
async function crashedJournal(clientMessageId = 'cm_1', text = 'deploy the thing') {
  const journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root
  })
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: digestPayload(text),
    body: userMessage(text),
    fence: RECORD.lease.runtimeFence
  })
  await journal.close()
}

async function attach(providerHistoryWindow: PlacedProviderHistoryWindow | null) {
  const attached = await attachJournal({
    record: RECORD,
    openConversation: openTestAttachConversation(openTestJournalHostDatabase(root)),
    logger: recordingStructuredAgentSessionLogger().logger,
    providerHistoryWindow
  })
  journals.track(attached.journal)
  return attached
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-attach-reconcile-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('attachJournal restart reconciliation', () => {
  it('keeps committed settlements after a later write fails and re-derives the remainder', async () => {
    await crashedJournal('cm_1', 'first')
    await crashedJournal('cm_2', 'second')
    const journal = journals.track(
      await openTestAttachConversation(openTestJournalHostDatabase(root))(RECORD)
    )
    const providerHistoryWindow = window({
      items: ['cm_1', 'cm_2'].map((clientMessageId, index) => ({
        clientMessageId,
        providerItemId: `item-${index}`,
        payloadFingerprint: null,
        identity: {
          provider: 'claude',
          sessionId: 'provider-session-alpha-1',
          uuid: `item-${index}`
        }
      }))
    })
    const logging = recordingStructuredAgentSessionLogger()
    const resolve = journal.resolveDispatch
    const writes = vi.spyOn(journal, 'resolveDispatch')
    writes.mockImplementation(function (this: AgentSessionJournal, input, hook) {
      if (input.clientMessageId === 'cm_2' && input.state === 'accepted') {
        return Promise.reject(new Error('disk full on second settlement'))
      }
      return resolve.call(this, input, hook)
    })
    const input = {
      record: RECORD,
      logger: logging.logger,
      openConversation: async () => journal,
      providerHistoryWindow
    }

    expect((await attachJournal(input)).unconfirmedClientMessageIds).toEqual(['cm_2'])
    expect(journal.submissions().map((send) => send.dispatchState)).toEqual(['accepted', 'unknown'])
    expect(logging.scopes()).toEqual(['attach-send-reconcile'])
    writes.mockRestore()

    expect((await attachJournal(input)).unconfirmedClientMessageIds).toEqual([])
    expect(journal.submissions().map((send) => send.dispatchState)).toEqual([
      'accepted',
      'accepted'
    ])
  })

  it('settles a provably undelivered submission and stops reporting it unconfirmed', async () => {
    await crashedJournal()

    const attached = await attach(window())

    expect(attached.unconfirmedClientMessageIds).toEqual([])
    const submission = attached.journal.submissions()[0]
    expect(submission?.dispatchState).toBe('rejected')
    expect(submission?.rejection).toEqual({ kind: 'notDelivered' })
  })

  it('gives a send the provider never received no verdict and no listing', async () => {
    await crashedJournal()

    const attached = await attach(window())

    // Nobody failed: the crash stranded it, so the chat must not read Failed or be listed by it.
    const { items, submissions } = attached.journal.snapshot()
    expect(
      projectStructuredAgentSessionStatusState(items, submissions, RECORD.lease.runtimeFence)
    ).toMatchObject({ summary: { status: null }, latestRequest: null })
  })

  it('still reports a submission unconfirmed when the window cannot decide it', async () => {
    await crashedJournal()

    const attached = await attach(window({ turnInFlight: true }))

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_1'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
  })

  it('leaves the crash boundary untouched when there is no history to use', async () => {
    await crashedJournal()

    const attached = await attach(null)

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_1'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
  })

  // The send went out under fence 7 with the resume point at leaf-a; history read from the head
  // holds it either way. What decides is whether that head was set before the send.
  const AFTER_THE_SEND = Number.MAX_SAFE_INTEGER
  it.each([
    [
      'still rejects it after a later owner re-proved the same point',
      1,
      'leaf-a',
      2_000,
      'rejected'
    ],
    ['leaves it unknown once a later owner moved the point', 1, 'leaf-b', 2_000, 'unknown'],
    [
      'rejects it when its own owner moved the point before the send',
      0,
      'leaf-b',
      2_000,
      'rejected'
    ],
    [
      'leaves it unknown when its own owner moved the point after the send',
      0,
      'leaf-b',
      AFTER_THE_SEND,
      'unknown'
    ]
  ])('%s', async (_, laterFence, leaf, movedAt, expected) => {
    await crashedJournal()
    const fence = RECORD.lease.runtimeFence
    const first = {
      ...RECORD.providerHandleChain[0]!,
      handle: claudeProviderHandle(SESSION_ID, 'leaf-a')
    }
    const head = {
      ...first,
      linkId: `link-at-${fence + laterFence}`,
      origin: laterFence ? ('resumed' as const) : first.origin,
      mintedAtFence: fence + laterFence,
      observedAt: movedAt,
      handle: claudeProviderHandle(SESSION_ID, leaf)
    }
    const record = {
      ...RECORD,
      lease: { ...RECORD.lease, runtimeFence: fence + 2 },
      providerHandleChain: laterFence ? [first, head] : [head]
    }
    const providerHistoryWindow = await sampleProviderHistoryWindow({
      adapter: { providerHistoryWindow: async () => window() },
      identity: journalIdentityFor(record, PARAMS),
      record,
      ownerAlreadyAdmitted: false
    })

    const attached = await attachJournal({
      record,
      openConversation: openTestAttachConversation(openTestJournalHostDatabase(root)),
      logger: recordingStructuredAgentSessionLogger().logger,
      providerHistoryWindow
    })
    journals.track(attached.journal)

    expect(attached.journal.submissions()[0]?.dispatchState).toBe(expected)
  })

  it('leaves a message the open conversation still has queued alone (W4′e)', async () => {
    const journal = await journals.open({
      identity: IDENTITY,
      stateDirectory: root
    })
    await journal.appendSubmission({
      clientMessageId: 'queued',
      payloadFingerprint: digestPayload('still queued'),
      body: userMessage('still queued'),
      fence: RECORD.lease.runtimeFence,
      handoverRecorded: true
    })
    // History that holds nothing: absence would prove a handed-over message undelivered.
    const attached = await attachJournal({
      record: RECORD,
      logger: recordingStructuredAgentSessionLogger().logger,
      openConversation: async () => journal,
      providerHistoryWindow: window()
    })

    expect(attached.journal).toBe(journal)
    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'pending' })
    expect(journal.submissions()[0]?.handedOverAt).toBeUndefined()
  })
})
