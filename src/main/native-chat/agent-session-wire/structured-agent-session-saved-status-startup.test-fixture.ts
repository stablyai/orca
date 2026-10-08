// A chat a crash left mid-turn, on disk as the next launch finds it: its record still names the dead
// owner, its journal still has the turn running, and `last-status.json` holds what the list last
// showed. The status sink is a real agent status store over that file.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentStatusStructuredSessionSubject } from '../../../shared/agent-status-subject'
import type {
  SavedStructuredSessionStatus,
  SavedStructuredSessionSummary
} from '../../../shared/structured-agent-session-saved-status'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { AgentHookServer } from '../../agent-hooks/server'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  HOST_TEST_LOCATION as LOCATION,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

const PROVIDER_SESSION = 'provider-session-saved-1'
export const FENCE = 13
export const STARTED_AT = 1_800_000_000_000
export const RELAUNCHED_AT = STARTED_AT + 60 * 60 * 1000
export const NEVER_WRITTEN = 'session-never-written-2'
/** Older than any age limit a saved status could have been given. */
export const NINE_DAYS_AGO = Date.now() - 9 * 24 * 60 * 60 * 1000

export function crashedRecord(sessionId = SESSION): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId,
    location: LOCATION,
    provider: 'claude',
    conversationName: 'Named on the record',
    providerHandleChain: [
      {
        linkId: 'link-13',
        handle: claudeProviderHandle(PROVIDER_SESSION, null),
        origin: 'created',
        mintedAtFence: FENCE,
        observedAt: STARTED_AT
      }
    ],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    lease: {
      sessionId,
      runtimeKind: 'native',
      runtimeFence: FENCE,
      handoffStage: null,
      provenHandleLinkId: 'link-13',
      ownerProcess: {
        hostId: 'local',
        pid: 12_546,
        processStartTimeMs: STARTED_AT,
        spawnToken: 'spawn-crashed'
      },
      reservedSpawnToken: 'spawn-crashed',
      leaseDeadlineAt: STARTED_AT + 30_000,
      lastRenewedAt: STARTED_AT,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    }
  }
}

/** A turn the crash left running, under the owner the lease names. */
export async function seedRunningTurn(root: string): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'claude',
      providerHandle: claudeProviderHandle(PROVIDER_SESSION, null)
    },
    database: openTestJournalHostDatabase(root),
    now: () => STARTED_AT
  })
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: '0'.repeat(64),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run the loop' }] },
    fence: FENCE
  })
  const identity = { provider: 'claude' as const, sessionId: PROVIDER_SESSION, uuid: 'uuid-turn' }
  await journal.appendItem(
    identity,
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: STARTED_AT },
    { fence: FENCE, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
  )
  await journal.close()
}

/** What the list showed before the crash, as the last run saved it. */
export function savedEntry(
  status: AgentSessionStatusSummary['status'],
  fields: Partial<SavedStructuredSessionSummary> = {},
  sessionId = SESSION
): SavedStructuredSessionStatus {
  return {
    summary: {
      sessionId,
      status,
      latestPrompt: 'what the list showed before the crash',
      updatedAt: NINE_DAYS_AGO,
      ...fields
    }
  }
}

export function lastStatusPath(userDataPath: string): string {
  return join(userDataPath, 'agent-hooks', 'last-status.json')
}

export function writeLastStatus(
  userDataPath: string,
  structuredSessions: Record<string, unknown>
): void {
  mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
  writeFileSync(
    lastStatusPath(userDataPath),
    JSON.stringify({ version: 2, entries: {}, structuredSessions })
  )
}

/** The agent status store as the host's sink; `ingested` holds every row the host offered it. */
export async function startStatusStore(userDataPath: string) {
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
  const ingested: AgentSessionStatusSummary[] = []
  const sink = {
    publish: (summary: AgentSessionStatusSummary, subject: AgentStatusStructuredSessionSubject) => {
      ingested.push(summary)
      server.ingestStructuredStatus(summary, subject)
    },
    forget: (subject: AgentStatusStructuredSessionSubject) => server.dropStructuredStatus(subject),
    readChildWork: (subject: AgentStatusStructuredSessionSubject) =>
      server.getStructuredChildWorkViews(subject),
    dropSavedStatus: (sessionId: string) => server.dropSavedStructuredStatus(sessionId),
    readSavedStatuses: () => server.readSavedStructuredStatuses()
  }
  return {
    server,
    sink,
    ingested,
    rowsFor: (id: string) => ingested.filter((s) => s.sessionId === id)
  }
}
