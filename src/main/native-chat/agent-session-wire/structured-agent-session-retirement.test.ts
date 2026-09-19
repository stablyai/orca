import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import {
  MAX_AGENT_SESSION_RETIREMENT_RECEIPTS,
  isAgentSessionRetirements
} from '../../../shared/agent-session-retirement'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  preserveStructuredSessionRetirement,
  retryStructuredSessionRetirements
} from './structured-agent-session-retirement'
import { reserveAgentSessionOwner } from '../../runtime/agent-session-lease-transitions'

let root: string
let journal: AgentSessionJournal
let record: AgentSessionRecord
const identity = { provider: 'codex', threadId: 'thread', turnId: 'old', ordinal: 1 } as const
const running = { kind: 'turn', turnId: 'old', state: 'running' } as const
const onError = vi.fn()
function context() {
  return {
    sessionId: record.sessionId,
    journal,
    now: () => 2000,
    onError,
    store: {
      getRecord: () => record,
      transitionHandoff: async (
        _id: string,
        transition: (record: AgentSessionRecord) => AgentSessionRecord
      ) => {
        record = transition(record)
        return record
      }
    }
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-retirement-'))
  record = agentSessionRecordFixture({
    ...agentSessionRecordFixture().lease,
    claimStatus: 'released',
    ownerProcess: null,
    settlementRetryRequired: true,
    settlementRetryId: 'retirement-one',
    deathEvidence: { kind: 'pid-absent', observedAt: 1000, detail: 'absent' }
  })
  journal = await openAgentSessionJournal({
    journalDir: root,
    identity: {
      sessionId: record.sessionId,
      hostId: 'local',
      workspaceId: 'workspace',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread' }
    }
  })
  await journal.appendItem(identity, running, { fence: record.lease.runtimeFence })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await journal.close()
  await rm(root, { recursive: true, force: true })
})
it('preserves exact targets through reservation; new same-ID work defeats the old repair', async () => {
  expect(await preserveStructuredSessionRetirement(context())).toBe(true)
  expect(isAgentSessionRetirements(record.retirements)).toBe(true)
  const retained = JSON.stringify(record.retirements)
  record = reserveAgentSessionOwner({
    record,
    expectedFence: record.lease.runtimeFence,
    probe: { outcome: 'pid-absent' },
    reservation: {
      runtimeKind: 'native',
      spawnToken: 'next',
      claimKeyId: 'key',
      handoffOperationId: null,
      leaseTtlMs: 30000,
      now: 2000
    }
  }).record
  expect(JSON.stringify(record.retirements)).toBe(retained)
  await journal.appendItem(identity, running, { fence: record.lease.runtimeFence })
  expect(await retryStructuredSessionRetirements(context())).toBe(true)
  expect(journal.snapshot().items[0]?.body).toEqual(running)
  expect(record.retirements?.receipts).toEqual([])
})
it('old repair failure is independent of durable new submission admission', async () => {
  expect(await preserveStructuredSessionRetirement(context())).toBe(true)
  vi.spyOn(journal.retirement, 'repairItem').mockRejectedValue(
    new Error('historical repair failed')
  )
  expect(await retryStructuredSessionRetirements(context())).toBe(false)
  expect(record.lease.settlementRetryRequired).toBeUndefined()
  await expect(
    journal.appendSubmission({
      clientMessageId: 'new-send',
      payloadFingerprint: 'new',
      fence: record.lease.runtimeFence,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'new work' }] }
    })
  ).resolves.toBeDefined()
  expect(record.retirements?.receipts).toHaveLength(1)
})
it('record persistence failure remains an admission barrier', async () => {
  const input = context()
  input.store.transitionHandoff = async () => {
    throw new Error('record failed')
  }
  expect(await preserveStructuredSessionRetirement(input)).toBe(false)
  expect(record.lease.settlementRetryRequired).toBe(true)
})
it('bounded successive retirements explicitly abandon overflow', async () => {
  for (let i = 0; i <= MAX_AGENT_SESSION_RETIREMENT_RECEIPTS; i++) {
    record = {
      ...record,
      lease: { ...record.lease, settlementRetryRequired: true, settlementRetryId: `exit-${i}` }
    }
    expect(await preserveStructuredSessionRetirement(context())).toBe(true)
  }
  expect(record.retirements?.receipts).toHaveLength(MAX_AGENT_SESSION_RETIREMENT_RECEIPTS)
  expect(record.retirements?.abandonedCount).toBe(1)
  expect(record.retirements?.lastAbandonedReason).toBe('quota')
  expect(isAgentSessionRetirements(record.retirements)).toBe(true)
})
it('unreadable capture has a durable abandonment disposition', async () => {
  vi.spyOn(journal.retirement, 'capture').mockResolvedValue({
    disposition: 'abandoned',
    reason: 'unreadable'
  })
  expect(await preserveStructuredSessionRetirement(context())).toBe(true)
  expect(record.retirements).toMatchObject({
    receipts: [],
    abandonedCount: 1,
    lastAbandonedReason: 'unreadable'
  })
  expect(record.lease.settlementRetryRequired).toBeUndefined()
  await retryStructuredSessionRetirements(context())
  expect(
    journal
      .snapshot()
      .items.some(
        (item) => item.body.kind === 'status' && item.body.text.includes('could not be reconciled')
      )
  ).toBe(true)
})

it('does not recapture an abandoned frontier after later writes at the released fence', async () => {
  const capture = vi
    .spyOn(journal.retirement, 'capture')
    .mockResolvedValueOnce({ disposition: 'abandoned', reason: 'unreadable' })
  expect(await preserveStructuredSessionRetirement(context())).toBe(true)
  await journal.appendItem(
    { ...identity, turnId: 'later' },
    { ...running, turnId: 'later' },
    { fence: record.lease.runtimeFence }
  )
  expect(await preserveStructuredSessionRetirement(context())).toBe(true)
  expect(capture).toHaveBeenCalledOnce()
  expect(record.retirements?.abandonedCount).toBe(1)
})
