import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// The settlement latch governs EVERY unclean restart — SIGKILL, force quit, OOM, a quit that blew
// its deadline — so the evidence it reads decides whether the user sees a failure notice at all.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionDeathEvidence,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionLeaseStore } from './structured-agent-session-lease-release'
import { retryLoadedStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'

const SESSION = 'session-alpha-1'
const THREAD = 'thread-1'
const FENCE = 8

let root: string
let journal: AgentSessionJournal
let record: AgentSessionRecord

function store(): StructuredAgentSessionLeaseStore {
  return {
    getRecord: () => record,
    transitionHandoff: async (_sessionId, transition) => {
      record = transition(record)
      return record
    }
  }
}

function retry(settlementId: string, deathEvidence: AgentSessionDeathEvidence) {
  record = agentSessionRecordFixture({
    ...agentSessionRecordFixture().lease,
    runtimeKind: 'native',
    runtimeFence: FENCE,
    deathEvidence,
    settlementRetryRequired: true,
    settlementRetryId: settlementId
  })
  return retryLoadedStructuredAgentSessionSettlement({
    deps: { store: store() },
    sessionId: SESSION,
    journal,
    now: () => 2_000
  })
}

function statusTexts(): string[] {
  return journal
    .snapshot()
    .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-settlement-retry-'))
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: root,
    now: () => 1_000
  })
})

/** A turn the dead generation left running: work to settle either way. */
async function seedRunningTurn(): Promise<void> {
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 900 },
    { fence: FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** The provider died while the user, not the provider, held the conversation. */
async function seedIdlePendingApproval(): Promise<void> {
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
    {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

afterEach(async () => {
  await journal.close()
  await rm(root, { recursive: true, force: true })
})

describe('pending settlement retry', () => {
  it('writes no status row when the death was only adjudicated, not witnessed', async () => {
    await seedRunningTurn()

    await expect(
      retry(`restart-eviction:${SESSION}:${FENCE}`, {
        kind: 'pid-absent',
        detail: 'recorded pid absent on host',
        observedAt: 1_500
      })
    ).resolves.toBe(true)

    expect(statusTexts()).toEqual([])
    expect(journal.snapshot().items.map((item) => item.body)).toContainEqual(
      expect.objectContaining({ kind: 'turn', state: 'unverifiable' })
    )
    expect(record.lease.settlementRetryRequired).toBeUndefined()
  })

  it('leaves a message queued for the next child to that child', async () => {
    await seedRunningTurn()
    await journal.appendSubmission({
      clientMessageId: 'queued',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      fence: FENCE,
      handoverRecorded: true
    })

    await expect(
      retry(`restart-eviction:${SESSION}:${FENCE}`, {
        kind: 'pid-absent',
        detail: 'recorded pid absent on host',
        observedAt: 1_500
      })
    ).resolves.toBe(true)

    // The retry settles the generation that died; the message was never that child's.
    expect(journal.submissions()).toEqual([
      expect.objectContaining({ clientMessageId: 'queued', dispatchState: 'pending' })
    ])
    expect(journal.submissions()[0]?.handedOverAt).toBeUndefined()
  })

  it('writes no status row for an identity mismatch either', async () => {
    await seedRunningTurn()

    await expect(
      retry(`restart-eviction:${SESSION}:${FENCE}`, {
        kind: 'identity-mismatch',
        detail: 'mismatched spawn-token',
        observedAt: 1_500
      })
    ).resolves.toBe(true)

    expect(statusTexts()).toEqual([])
  })

  it('reads the evidence, not the settlement id, when deciding to speak', async () => {
    // Pins the discriminator: the id shape that normally accompanies a witnessed exit must not
    // earn the notice on its own.
    await seedRunningTurn()

    await expect(
      retry(`provider-exit:${SESSION}:${FENCE}:generation-1`, {
        kind: 'pid-absent',
        detail: 'recorded pid absent on host',
        observedAt: 1_500
      })
    ).resolves.toBe(true)

    expect(statusTexts()).toEqual([])
  })

  it('writes user-facing copy carrying the cause when the exit was observed', async () => {
    await seedRunningTurn()

    await expect(
      retry(`provider-exit:${SESSION}:${FENCE}:generation-1`, {
        kind: 'exit-observed',
        detail: 'transport closed',
        observedAt: 1_500
      })
    ).resolves.toBe(true)

    expect(statusTexts()).toEqual([
      'The provider stopped while this response was in progress: transport closed. You can continue in this conversation.'
    ])
    expect(journal.snapshot().items.map((item) => item.body)).toContainEqual(
      expect.objectContaining({ kind: 'turn', state: 'interrupted', completedAt: 1_500 })
    )
  })

  it('stays silent about a witnessed exit that interrupted nothing but a waiting prompt', async () => {
    await seedIdlePendingApproval()

    await expect(
      retry(`provider-exit:${SESSION}:${FENCE}:generation-1`, {
        kind: 'exit-observed',
        detail: 'transport closed',
        observedAt: 1_500
      })
    ).resolves.toBe(true)

    expect(statusTexts()).toEqual([])
    expect(journal.snapshot().items.map((item) => item.body)).toContainEqual(
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'cancelled' })
      })
    )
  })
})
