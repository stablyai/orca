// A roster row and a background-task row are revised in place across generations, so each entry
// carries the generation that last observed it. Settling an ended generation settles only the
// entries it observed; a later live generation's children stay as they are. And a proof the
// retry holds for an ended generation revises what an earlier settle of it could
// only call unverifiable.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { backgroundTaskJournalBody } from '../../../shared/native-chat-background-task-row'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatBackgroundTaskBlock,
  type NativeChatSubagentEntry
} from '../../../shared/native-chat-types'
import {
  claudeBackgroundTaskIdentity,
  claudeBackgroundTaskBody
} from '../../claude/claude-background-task-row-journal'
import {
  claudeSubagentGroupBody,
  claudeSubagentGroupIdentity
} from '../../claude/claude-subagent-group-row'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { stampJournalEntryProvenance } from '../agent-session-journal/journal-item-provenance'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { settleStructuredAgentSessionLeftovers } from './structured-agent-session-leftover-settlement'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import { backgroundSettlementWrites } from './structured-agent-session-background-writes'

const SESSION = 'orca-session'
const GROUP = 'claude-session:turn-a'
const ENDED = 1
const LIVE = 3

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-roster-provenance-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function child(id: string, extra: Partial<NativeChatSubagentEntry> = {}): NativeChatSubagentEntry {
  return { id, label: `Child ${id}`, state: 'working', startedAt: 1, ...extra }
}

function task(
  taskId: string,
  extra: Partial<NativeChatBackgroundTaskBlock> = {}
): NativeChatBackgroundTaskBlock {
  return {
    type: 'background-task',
    taskId,
    kind: 'command',
    label: `Task ${taskId}`,
    state: 'working',
    startedAt: 1,
    ...extra
  }
}

/** One provider process of generation `fence`, observing rows through the host's event sink. */
async function observeAt(
  journal: AgentSessionJournal,
  fence: number,
  rows: readonly (readonly [ReturnType<typeof claudeSubagentGroupIdentity>, AgentJournalItemBody])[]
): Promise<void> {
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence, publish: () => {} })
  for (const [identity, body] of rows) {
    deferred.sink.appendItem(identity, body, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  }
  await expect(deferred.drained()).resolves.toEqual({ ok: true })
  deferred.close()
}

function children(journal: AgentSessionJournal): NativeChatSubagentEntry[] {
  return journal
    .snapshot()
    .items.flatMap((item) =>
      item.body.kind === 'message'
        ? item.body.blocks.flatMap((block) => (isSubagentGroupBlock(block) ? block.agents : []))
        : []
    )
}

function tasks(journal: AgentSessionJournal): NativeChatBackgroundTaskBlock[] {
  return journal
    .snapshot()
    .items.flatMap((item) =>
      item.body.kind === 'message' ? item.body.blocks.filter(isBackgroundTaskBlock) : []
    )
}

function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9_000,
    stateDirectory: root
  })
}

describe('a roster entry’s provenance', () => {
  const group = (agents: NativeChatSubagentEntry[]) => claudeSubagentGroupBody(GROUP, agents)
  const agentsOf = (body: AgentJournalItemBody) =>
    body.kind === 'message'
      ? body.blocks.flatMap((b) => (isSubagentGroupBlock(b) ? b.agents : []))
      : []

  it('is the observing generation’s for a new or changed entry, and kept for one carried unchanged', () => {
    const before = group([child('a', { ownerFence: ENDED }), child('b', { ownerFence: ENDED })])
    const after = stampJournalEntryProvenance(
      group([child('a'), child('b', { state: 'completed' }), child('c')]),
      { body: before, ownerFence: ENDED },
      LIVE
    )
    expect(agentsOf(after).map(({ id, ownerFence }) => [id, ownerFence])).toEqual([
      ['a', ENDED],
      ['b', LIVE],
      ['c', LIVE]
    ])
  })

  it('falls back to the row’s own provenance for an entry an older build never stamped', () => {
    const before = group([child('a')])
    const after = stampJournalEntryProvenance(
      group([child('a')]),
      { body: before, ownerFence: 2 },
      LIVE
    )
    expect(agentsOf(after)[0]?.ownerFence).toBe(2)
  })

  it('keeps a stamp history carried into a new epoch already names', () => {
    const after = stampJournalEntryProvenance(
      group([child('a', { ownerFence: ENDED })]),
      undefined,
      LIVE
    )
    expect(agentsOf(after)[0]?.ownerFence).toBe(ENDED)
  })
})

describe('settling an ended generation’s roster', () => {
  it('settles only the children and tasks it observed; the live generation’s stay working', async () => {
    const journal = await openJournal()
    // Generation F spawns a child and starts two background commands, then dies uncleaned.
    await observeAt(journal, ENDED, [
      [claudeSubagentGroupIdentity(GROUP), claudeSubagentGroupBody(GROUP, [child('a')])],
      [claudeBackgroundTaskIdentity('bg-1'), claudeBackgroundTaskBody(task('bg-1'))],
      [claudeBackgroundTaskIdentity('bg-2'), claudeBackgroundTaskBody(task('bg-2'))]
    ])
    // Generation F+1 resumes the same group row with a new child of its own, carrying F's child
    // unchanged, and reports progress on one of F's commands, which it now runs.
    await observeAt(journal, LIVE, [
      [
        claudeSubagentGroupIdentity(GROUP),
        claudeSubagentGroupBody(GROUP, [child('a'), child('b')])
      ],
      [
        claudeBackgroundTaskIdentity('bg-2'),
        backgroundTaskJournalBody(task('bg-2', { tokens: 50 }))
      ]
    ])
    expect(children(journal).map(({ id, ownerFence }) => [id, ownerFence])).toEqual([
      ['a', ENDED],
      ['b', LIVE]
    ])
    expect(tasks(journal).map(({ taskId, ownerFence }) => [taskId, ownerFence])).toEqual([
      ['bg-1', ENDED],
      ['bg-2', LIVE]
    ])

    // F+1 holds the lease, live; the settlement judges everything below it.
    const live = agentSessionRecordFixture(
      agentSessionLeaseFixture({ sessionId: SESSION, runtimeFence: LIVE })
    )
    expect(
      await settleStructuredAgentSessionLeftovers({
        store: { getRecord: (sessionId) => (sessionId === SESSION ? live : null) },
        sessionId: SESSION,
        journal,
        writes: backgroundSettlementWrites(journal)
      })
    ).toMatchObject({ ok: true })

    expect(children(journal).map(({ id, state }) => [id, state])).toEqual([
      ['a', 'unverifiable'],
      ['b', 'working']
    ])
    expect(tasks(journal).map(({ taskId, state }) => [taskId, state])).toEqual([
      ['bg-1', 'unverifiable'],
      ['bg-2', 'working']
    ])
    // Settled once: a second pass finds nothing of F's left.
    expect(
      await settleStructuredAgentSessionLeftovers({
        store: { getRecord: () => live },
        sessionId: SESSION,
        journal,
        writes: backgroundSettlementWrites(journal)
      })
    ).toEqual({ ok: true, planned: 0 })
  })
})

describe('a held proof', () => {
  it('upgrades a turn an unproven settle left unverifiable to interrupted, once the lease forgot it', async () => {
    const journal = await openJournal()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence: ENDED, publish: () => {} })
    deferred.sink.appendItem(
      { provider: 'claude', sessionId: 'claude-session', uuid: 'turn' },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1_000 },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    deferred.close()
    const turn = () =>
      journal
        .snapshot()
        .items.map((item) => readAgentJournalTurn(item.body))
        .find(Boolean)
    // Released with nothing proving the owner gone: less specific, never wrong.
    const released = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: SESSION,
        runtimeFence: ENDED + 1,
        claimStatus: 'released',
        ownerProcess: null,
        reservedSpawnToken: null
      })
    )
    await settleStructuredAgentSessionLeftovers({
      store: { getRecord: () => released },
      sessionId: SESSION,
      journal,
      writes: backgroundSettlementWrites(journal)
    })
    expect(turn()).toMatchObject({ state: 'unverifiable' })

    // A later probe proved that owner gone; a reservation since cleared the lease's copy, and the
    // retry holds the proof it was handed.
    const live = agentSessionRecordFixture(
      agentSessionLeaseFixture({ sessionId: SESSION, runtimeFence: LIVE })
    )
    expect(
      await settleStructuredAgentSessionLeftovers({
        store: { getRecord: () => live },
        sessionId: SESSION,
        journal,
        writes: backgroundSettlementWrites(journal),
        proof: { kind: 'pid-absent', detail: 'owner gone', observedAt: 2_000, ownerFence: ENDED }
      })
    ).toMatchObject({ ok: true })
    expect(turn()).toMatchObject({ state: 'interrupted' })
  })
})
