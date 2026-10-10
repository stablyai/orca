// Chats an earlier process left, for the startup-scan suites: records on disk, each journal with a
// running turn at fence 13, and a host over them with no provider.

import { vi, expect } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { HOST_TEST_LOCATION as LOCATION } from './structured-agent-session-host-test-data'
import {
  createStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'
import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'
import { retryOwes } from './structured-agent-session-retry.test-fixture'

export const SCAN_NOW = 1_800_000_000_000
export const SCAN_CHATS = [
  'chat-aaaaaaa1',
  'chat-aaaaaaa2',
  'chat-aaaaaaa3',
  'chat-aaaaaaa4',
  'chat-aaaaaaa5'
]
export const SCAN_LATE = 'chat-aaaaaaa6'
/** Released long ago with nothing proving its owner gone: no restart moves its fence. */
export const SCAN_RELEASED = 'chat-released1'

export function scanRecord(
  sessionId: string,
  released: boolean,
  extra: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  const linkId = `${sessionId}-link`
  return {
    schemaVersion: 2,
    sessionId,
    location: LOCATION,
    provider: 'claude',
    providerHandleChain: [
      {
        linkId,
        handle: claudeProviderHandle(`provider-${sessionId}`, null),
        origin: 'created',
        mintedAtFence: 13,
        observedAt: SCAN_NOW - 60_000
      }
    ],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    createdAt: SCAN_NOW - 60_000,
    updatedAt: SCAN_NOW,
    lease: {
      sessionId,
      runtimeKind: 'native',
      runtimeFence: released ? 14 : 13,
      handoffStage: null,
      provenHandleLinkId: linkId,
      ownerProcess: released
        ? null
        : {
            hostId: 'local',
            pid: 12_000,
            processStartTimeMs: SCAN_NOW - 60_000,
            spawnToken: 'spawn'
          },
      reservedSpawnToken: released ? null : 'spawn',
      leaseDeadlineAt: SCAN_NOW + 30_000,
      lastRenewedAt: SCAN_NOW,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: released ? 'released' : 'live',
      unreconciled: false,
      deathEvidence: null
    },
    ...extra
  }
}

/** The chat's journal as the crashed process left it: a running turn at fence 13, and, when
 *  asked, a send it accepted and never handed over (at `queuedFence`, the released lease's 14 by
 *  default), or one it handed to the generation at `handedOverAt` that never answered it. */
export async function seedScanJournal(
  root: string,
  sessionId: string,
  options: { queued?: true; queuedFence?: number; handedOverAt?: number } = {}
): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'claude',
      providerHandle: claudeProviderHandle(`provider-${sessionId}`, null)
    },
    database: openTestJournalHostDatabase(root),
    now: () => SCAN_NOW
  })
  await journal.appendItem(
    { provider: 'claude', sessionId: `provider-${sessionId}`, uuid: 'turn' },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: SCAN_NOW - 30_000 },
    { fence: 13, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  if (options.queued) {
    await journal.appendSubmission({
      clientMessageId: `${sessionId}-queued`,
      payloadFingerprint: '0'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'after this' }] },
      fence: options.queuedFence ?? 14,
      handoverRecorded: true,
      origin: 'client',
      source: { kind: 'user' }
    })
  }
  const fence = options.handedOverAt
  if (fence !== undefined) {
    const clientMessageId = `${sessionId}-handed`
    await journal.appendSubmission({
      clientMessageId,
      payloadFingerprint: '1'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'handed over' }] },
      fence,
      handoverRecorded: true,
      origin: 'client',
      source: { kind: 'user' }
    })
    await journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  await journal.close()
}

export function openScanHost(
  root: string,
  store: AgentSessionRecordStore,
  options: {
    logger?: StructuredAgentSessionLogger
    statusSink?: StructuredAgentSessionStatusSink
  } & Partial<Pick<StructuredAgentSessionHostDeps, 'probeOwner' | 'stopOwnerProcess'>> = {}
): StructuredAgentSessionHost {
  return new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: options.logger ?? createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    ...(options.statusSink ? { statusSink: options.statusSink } : {}),
    ...(options.stopOwnerProcess ? { stopOwnerProcess: options.stopOwnerProcess } : {}),
    probeOwner: options.probeOwner ?? (async () => ({ outcome: 'pid-absent' })),
    now: () => SCAN_NOW
  })
}

/** The turn's state as a reader sees it; the read opens the chat. */
export async function scanTurnState(current: StructuredAgentSessionHost, sessionId: string) {
  return (await current.journalSnapshot(sessionId)).items
    .map((item) => readAgentJournalTurn(item.body))
    .find(Boolean)?.state
}

export async function scanIdle(current: StructuredAgentSessionHost, sessionIds: readonly string[]) {
  const { reconciliation } = current.collaboratorsForTests()
  await vi.waitFor(
    () =>
      expect(sessionIds.filter((sessionId) => retryOwes(reconciliation, sessionId))).toEqual([]),
    { timeout: 10_000 }
  )
}
