import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleBatchInput } from './journal-store-contracts'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function turnIdentity(turnId: string): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: 'codex',
    sessionId: IDENTITY.sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

function claudeTurnIdentity(turnId: string): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: 'claude',
    sessionId: IDENTITY.sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function terminalTurn(
  turnId: string,
  state: 'completed' | 'interrupted',
  ownerEndedClientMessageIds: readonly string[],
  settlementId = `${state}:${turnId}`
): JournalLifecycleBatchInput {
  return {
    settlementId,
    fence: 1,
    ownerEndedClientMessageIds,
    mutations: [
      {
        kind: 'item',
        identity: turnIdentity(turnId),
        body: { kind: 'turn', turnId, state }
      }
    ]
  }
}

async function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
}

async function appendPending(
  journal: AgentSessionJournal,
  clientMessageId: string,
  fence = 1
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: `fingerprint:${clientMessageId}`,
    body: userMessage(clientMessageId),
    fence
  })
}

async function openTurn(journal: AgentSessionJournal, turnId: string): Promise<void> {
  await journal.appendItem(
    turnIdentity(turnId),
    { kind: 'turn', turnId, state: 'running' },
    { fence: 1 }
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-turn-settlement-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('turn settlement dispatch resolution', () => {
  it('settles a pending submission when its turn is interrupted', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-1')
    await appendPending(journal, 'message-1')

    const settlement = await journal.appendLifecycleBatch(
      terminalTurn('turn-1', 'interrupted', ['message-1'])
    )

    expect(journal.submissions()).toEqual([
      expect.objectContaining({
        clientMessageId: 'message-1',
        dispatchState: 'unknown',
        reason: 'turn_settled_before_acknowledgement',
        recovered: true
      })
    ])
    const afterSettlement = journal.readSince(settlement)
    expect(afterSettlement.ok && afterSettlement.rows).toEqual([
      expect.objectContaining({ kind: 'dispatch', state: 'unknown', recovered: true })
    ])
  })

  it('settles a pending submission when its turn completes through the legacy carrier', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-2')
    await appendPending(journal, 'message-2')

    await journal.appendLifecycleBatch({
      settlementId: 'completed:turn-2',
      fence: 1,
      ownerEndedClientMessageIds: ['message-2'],
      mutations: [
        {
          kind: 'item',
          identity: turnIdentity('turn-2'),
          body: {
            kind: 'status',
            text: 'Done',
            turnLifecycle: { turnId: 'turn-2', state: 'completed' }
          }
        }
      ]
    })

    expect(journal.submissions()[0]).toMatchObject({
      dispatchState: 'unknown',
      reason: 'turn_settled_before_acknowledgement',
      recovered: true
    })
  })

  it('preserves a provider-owned queued send across Claude turn completion', async () => {
    const journal = await open()
    const identity = claudeTurnIdentity('claude-turn')
    await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'claude-turn', state: 'running' },
      { fence: 1 }
    )
    await appendPending(journal, 'claude-before-settlement')

    const settlement = journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'claude-turn', state: 'completed' },
      { fence: 1 }
    )
    const laterSubmission = appendPending(journal, 'claude-after-settlement')
    await Promise.all([settlement, laterSubmission])

    expect(
      journal.submissions().map(({ clientMessageId, dispatchState, reason }) => ({
        clientMessageId,
        dispatchState,
        reason
      }))
    ).toEqual([
      {
        clientMessageId: 'claude-before-settlement',
        dispatchState: 'pending',
        reason: null
      },
      {
        clientMessageId: 'claude-after-settlement',
        dispatchState: 'pending',
        reason: null
      }
    ])

    await journal.resolveDispatch({
      clientMessageId: 'claude-before-settlement',
      state: 'accepted',
      providerIdentity: {
        provider: 'legacy',
        agent: 'claude',
        sessionId: IDENTITY.sessionId,
        recordId: 'message:claude-echo'
      },
      fence: 1
    })
    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'accepted' })

    await journal.markPendingSubmissionsUnknown(1, 'provider_exited_before_acknowledgement')
    expect(journal.submissions()[1]).toMatchObject({
      dispatchState: 'unknown',
      reason: 'provider_exited_before_acknowledgement',
      recovered: true
    })
  })

  it('does not settle a submission appended after the settlement row', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-3')
    await appendPending(journal, 'before-settlement')

    const settlement = journal.appendLifecycleBatch(
      terminalTurn('turn-3', 'completed', ['before-settlement'])
    )
    const laterSubmission = appendPending(journal, 'after-settlement')
    await Promise.all([settlement, laterSubmission])

    expect(
      journal.submissions().map(({ clientMessageId, dispatchState }) => ({
        clientMessageId,
        dispatchState
      }))
    ).toEqual([
      { clientMessageId: 'before-settlement', dispatchState: 'unknown' },
      { clientMessageId: 'after-settlement', dispatchState: 'pending' }
    ])
  })

  it('settles only the exact provider-owned submission', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-exact')
    await appendPending(journal, 'owned-by-turn')
    await appendPending(journal, 'owned-elsewhere')

    await journal.appendLifecycleBatch(terminalTurn('turn-exact', 'completed', ['owned-by-turn']))

    expect(
      journal.submissions().map(({ clientMessageId, dispatchState }) => ({
        clientMessageId,
        dispatchState
      }))
    ).toEqual([
      { clientMessageId: 'owned-by-turn', dispatchState: 'unknown' },
      { clientMessageId: 'owned-elsewhere', dispatchState: 'pending' }
    ])
  })

  it('does not settle later submissions when a settlement id is replayed', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-4')
    await appendPending(journal, 'original')
    const input = terminalTurn('turn-4', 'completed', ['original'], 'stable-settlement')
    await journal.appendLifecycleBatch(input)
    await appendPending(journal, 'later')
    const beforeReplay = journal.cursor()

    const replay = await journal.appendLifecycleBatch(input)

    expect(replay).toEqual(beforeReplay)
    expect(journal.cursor()).toEqual(beforeReplay)
    expect(journal.submissions().find((entry) => entry.clientMessageId === 'later')).toMatchObject({
      dispatchState: 'pending'
    })
  })

  it('settles an exact send for a delayed terminal while preserving the newer active turn', async () => {
    const journal = await open()
    await openTurn(journal, 'old-turn')
    await appendPending(journal, 'old-message')
    await openTurn(journal, 'active-turn')
    await appendPending(journal, 'active-message')

    await journal.appendLifecycleBatch(terminalTurn('old-turn', 'completed', ['old-message']))

    expect(journal.activeTurnId()).toBe('active-turn')
    expect(
      journal.submissions().map(({ clientMessageId, dispatchState }) => ({
        clientMessageId,
        dispatchState
      }))
    ).toEqual([
      { clientMessageId: 'old-message', dispatchState: 'unknown' },
      { clientMessageId: 'active-message', dispatchState: 'pending' }
    ])
  })

  it('does not let a repeated direct terminal record settle a later submission', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-repeated')
    await appendPending(journal, 'original')
    const identity = turnIdentity('turn-repeated')
    const completed = {
      kind: 'turn' as const,
      turnId: 'turn-repeated',
      state: 'completed' as const
    }
    await journal.appendItem(identity, completed, {
      fence: 1,
      ownerEndedClientMessageIds: ['original']
    })
    await appendPending(journal, 'later')

    await journal.appendItem(identity, completed, {
      fence: 1,
      ownerEndedClientMessageIds: ['original']
    })

    expect(journal.submissions().find((entry) => entry.clientMessageId === 'later')).toMatchObject({
      dispatchState: 'pending'
    })
  })

  it.each(['accepted', 'rejected'] as const)(
    'lets late %s evidence narrow a turn-settled unknown',
    async (state) => {
      const journal = await open()
      await openTurn(journal, `turn-late-${state}`)
      await appendPending(journal, `late-${state}`)
      await journal.appendLifecycleBatch(
        terminalTurn(`turn-late-${state}`, 'completed', [`late-${state}`])
      )

      await journal.resolveDispatch(
        state === 'accepted'
          ? {
              clientMessageId: `late-${state}`,
              state,
              providerIdentity: {
                provider: 'codex',
                threadId: 'thread-1',
                turnId: `turn-late-${state}`,
                ordinal: 0
              },
              fence: 1
            }
          : {
              clientMessageId: `late-${state}`,
              state,
              reason: 'provider later rejected the send',
              fence: 1
            }
      )

      expect(journal.submissions()[0]).toMatchObject({ dispatchState: state })
      expect(journal.submissions()[0]).not.toHaveProperty('recovered')
    }
  )

  it('retires an exact live unknown when its owner turn ends', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-live-unknown')
    await appendPending(journal, 'live-unknown')
    await journal.resolveDispatch({
      clientMessageId: 'live-unknown',
      state: 'unknown',
      reason: 'provider response timed out',
      fence: 1
    })

    await journal.appendLifecycleBatch(
      terminalTurn('turn-live-unknown', 'completed', ['live-unknown'])
    )

    expect(journal.submissions()[0]).toMatchObject({
      dispatchState: 'unknown',
      reason: 'turn_settled_before_acknowledgement',
      recovered: true
    })
  })

  it('does not settle a pending submission from another fence', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-fenced')
    await appendPending(journal, 'older-owner')
    const input = terminalTurn('turn-fenced', 'interrupted', ['older-owner'])

    await journal.appendLifecycleBatch({ ...input, fence: 2 })

    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'pending', fence: 1 })
  })

  it('does not overwrite an already accepted submission', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-5')
    await appendPending(journal, 'accepted')
    const providerIdentity: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-5',
      ordinal: 0
    }
    await journal.resolveDispatch({
      clientMessageId: 'accepted',
      state: 'accepted',
      providerIdentity,
      fence: 1
    })

    await journal.appendLifecycleBatch(terminalTurn('turn-5', 'completed', ['accepted']))

    expect(journal.submissions()[0]).toMatchObject({
      dispatchState: 'accepted',
      reason: null
    })
  })

  it('rolls back the terminal row when an exact dispatch row cannot be persisted', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-6')
    await appendPending(journal, 'write-fails')
    const before = journal.cursor()
    const setup = openJournalDatabase(journalDatabaseFile(root))
    setup.db.exec(`CREATE TRIGGER reject_dispatch_row
      BEFORE INSERT ON journal_rows
      WHEN instr(NEW.row_json, '"kind":"dispatch"') > 0
      BEGIN SELECT RAISE(ABORT, 'dispatch write failed'); END`)
    setup.db.close()

    await expect(
      journal.appendLifecycleBatch(terminalTurn('turn-6', 'interrupted', ['write-fails']))
    ).rejects.toThrow('dispatch write failed')
    expect(journal.cursor()).toEqual(before)
    expect(journal.activeTurnId()).toBe('turn-6')
    expect(journal.submissions()[0]).toMatchObject({ dispatchState: 'pending' })

    const cleanup = openJournalDatabase(journalDatabaseFile(root))
    cleanup.db.exec('DROP TRIGGER reject_dispatch_row')
    cleanup.db.close()
    await journal.appendLifecycleBatch(terminalTurn('turn-6', 'interrupted', ['write-fails']))
    expect(journal.activeTurnId()).toBeNull()
    expect(journal.submissions()[0]).toMatchObject({
      dispatchState: 'unknown',
      recovered: true
    })
  })

  it('replays the terminal row and its exact dispatch outcome together', async () => {
    const journal = await open()
    await openTurn(journal, 'turn-crash-window')
    await appendPending(journal, 'unwritten-settlement')
    await journal.appendLifecycleBatch(
      terminalTurn('turn-crash-window', 'completed', ['unwritten-settlement'])
    )
    await journal.close()

    const restarted = await open()
    expect(restarted.activeTurnId()).toBeNull()
    expect(restarted.hasTerminalTurn('turn-crash-window', 1)).toBe(true)
    expect(restarted.hasTerminalTurn('turn-crash-window', 2)).toBe(false)
    expect(restarted.submissions()[0]).toMatchObject({
      dispatchState: 'unknown',
      reason: 'turn_settled_before_acknowledgement',
      recovered: true
    })
  })
})
