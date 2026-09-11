// Attach is where the restart reconciler runs. These cover the wiring itself:
// that the window the adapter reports reaches the journal, that what it settles
// stops being reported unconfirmed, and that deciding never sends.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { digestPayload } from '../agent-session-journal/journal-payload-bounds'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachJournal,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'

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

let root: string
const journals = createTrackedJournalOpener()

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function window(overrides: Partial<ProviderHistoryWindow> = {}): ProviderHistoryWindow {
  return { items: [], boundaryConsistent: true, turnInFlight: false, ...overrides }
}

/** Only the surface `attachJournal` touches; every send-shaped method is a spy
 *  so a re-delivery would be visible rather than silent. */
function adapterWith(providerHistoryWindow?: () => Promise<ProviderHistoryWindow | null>): {
  adapter: StructuredAgentSessionAdapter
  dispatch: ReturnType<typeof vi.fn>
} {
  const dispatch = vi.fn()
  const adapter = {
    dispatch,
    ...(providerHistoryWindow ? { providerHistoryWindow } : {})
  } as unknown as StructuredAgentSessionAdapter
  return { adapter, dispatch }
}

/** A previous process wrote the submission row and died before its outcome. */
async function crashedJournal(clientMessageId = 'cm_1', text = 'deploy the thing') {
  const journal = await journals.open({
    identity: IDENTITY,
    journalDir: journalDirectoryFor(root, {
      workspaceId: IDENTITY.workspaceId,
      sessionId: IDENTITY.sessionId
    })
  })
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: digestPayload(text),
    body: userMessage(text),
    fence: RECORD.lease.runtimeFence
  })
  await journal.close()
}

async function attach(adapter: StructuredAgentSessionAdapter) {
  const attached = await attachJournal({
    record: RECORD,
    params: PARAMS,
    journalRoot: root,
    adapter
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
  it('settles a provably undelivered submission and stops reporting it unconfirmed', async () => {
    await crashedJournal()
    const { adapter, dispatch } = adapterWith(async () => window())

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual([])
    const submission = attached.journal.submissions()[0]
    expect(submission?.dispatchState).toBe('rejected')
    expect(submission?.reason).toBe('not_delivered')
    // Deciding is not sending: nothing here puts the message back on the wire.
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('still reports a submission unconfirmed when the window cannot decide it', async () => {
    await crashedJournal()
    const { adapter, dispatch } = adapterWith(async () => window({ turnInFlight: true }))

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_1'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('leaves the crash boundary untouched for an adapter that reports no history', async () => {
    await crashedJournal()
    const { adapter } = adapterWith()

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_1'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
  })

  it('does not fail the attach when reading provider history throws', async () => {
    await crashedJournal()
    const { adapter } = adapterWith(async () => {
      throw new Error('transcript unreadable')
    })

    const attached = await attach(adapter)

    expect(attached.unconfirmedClientMessageIds).toEqual(['cm_1'])
    expect(attached.journal.submissions()[0]?.dispatchState).toBe('unknown')
  })
})
