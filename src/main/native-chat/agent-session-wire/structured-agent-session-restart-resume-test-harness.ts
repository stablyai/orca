import type {
  AgentJournalApprovalItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { runningStructuredAgentSessionTurnItemBySequence } from '../../../shared/structured-agent-session-live-turn'
import type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-current-work'
import { structuredAgentSessionResumableSet } from './structured-agent-session-restart-resume-set'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'

export const SESSION = 'session-working-1'
export const THREAD = 'thread-1'
export const HANDLE_ROOT = `codex:${JSON.stringify(THREAD)}`
export const NOW = 1_700_000_000_000
/** Opaque teardown IDs do not encode ancestry. */
export const TEARDOWN_PREVIOUS = 'teardown-previous'
export const TEARDOWN_CURRENT = 'teardown-current'

export function turnItem(
  turnId: string,
  state: 'running' | 'completed' | 'interrupted' | 'unverifiable',
  /** Link submission to its opening turn; absent models older hosts. */
  userItemId?: string
): AgentJournalRenderItem {
  return {
    itemId: `turn:${turnId}`,
    revision: 1,
    body: { kind: 'turn', turnId, state, ...(userItemId === undefined ? {} : { userItemId }) },
    sequence: 1,
    observedAt: NOW
  }
}

export function record(overrides: { chain?: AgentSessionRecord['providerHandleChain'] } = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a literal fixture standing in for a durable record; the code under test reads only lease, provider, location and providerHandleChain.
  return {
    schemaVersion: 2,
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    providerHandleChain: overrides.chain ?? [
      {
        linkId: 'link-1',
        handle: codexProviderHandle(THREAD),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      }
    ],
    accountHome: { variable: 'CODEX_HOME', path: '/home/codex' },
    lease: {
      sessionId: SESSION,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: NOW,
      lastRenewedAt: NOW,
      handoffOperationId: null,
      claimKeyId: 'key-1',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: NOW,
    updatedAt: NOW
  } as unknown as AgentSessionRecord
}

export function liveLeaseRecord(): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the base fixture is already record-shaped; only claimStatus is overridden.
  return {
    ...record(),
    lease: { ...record().lease, claimStatus: 'live' }
  } as AgentSessionRecord
}

export function pendingApproval(): AgentJournalRenderItem & { body: AgentJournalApprovalItem } {
  return {
    itemId: 'approval:1',
    revision: 1,
    body: {
      kind: 'approval',
      title: 'Run the command?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    sequence: 2,
    observedAt: NOW
  }
}

export const CLAUDE_PROVIDER_SESSION = 'prov-session-1'
export const CLAUDE_ROOT = `claude:${JSON.stringify(CLAUDE_PROVIDER_SESSION)}`

/** Claude close can advance the leaf UUID without changing conversation identity. */
export function claudeRecord(
  leafUuid: string | null,
  providerSessionId = CLAUDE_PROVIDER_SESSION
): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the base fixture is already record-shaped; this only swaps the provider and its Claude handle chain.
  return {
    ...record(),
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/claude' },
    providerHandleChain: [
      {
        linkId: 'link-1',
        handle: claudeProviderHandle(providerSessionId, leafUuid),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      }
    ]
  } as unknown as AgentSessionRecord
}

export type HarnessJournal = {
  snapshot: () => {
    items: AgentJournalRenderItem[]
    submissions: AgentJournalSubmission[]
    cursor: { epoch: string; sequence: number }
  }
  submissions: () => AgentJournalSubmission[]
  appendItem: (envelope: unknown, body: { kind: string; text: string }) => Promise<void>
}

export type HarnessSession = { journal: HarnessJournal; child: { fence: number } | null }

export function journal(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[] = []
) {
  const currentWork: StructuredAgentSessionCurrentWorkJournal = {
    item: (itemId) => items.find((item) => item.itemId === itemId) ?? null,
    cursor: () => ({ epoch: EPOCH, sequence: items.length }),
    visitItems: (visit) => {
      for (const item of items) {
        visit(item.itemId, item.sequence, item.body)
      }
    },
    runningTurn: () => runningStructuredAgentSessionTurnItemBySequence(items),
    submissions: () => submissions,
    itemFence: () => undefined,
    wroteBeforeOpen: () => false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: current-work reads are checked above; the remaining exercised methods use the held fixture, without an on-disk SQLite store.
  return {
    ...currentWork,
    snapshot: () => ({ items, submissions, cursor: { epoch: EPOCH, sequence: items.length } }),
    appendItem: async () => undefined
  } as never
}

export function marker(
  overrides: Partial<AgentSessionResumeMarker> = {}
): AgentSessionResumeMarker {
  return {
    sessionId: SESSION,
    work: { kind: 'turn', id: 'turn-1' },
    recordedAt: NOW,
    trigger: 'quit',
    providerHandleRoot: HANDLE_ROOT,
    teardownId: TEARDOWN_PREVIOUS,
    latestUserItemId: null,
    ...overrides
  }
}

export function submission(
  clientMessageId: string,
  dispatchState: 'pending' | 'accepted' | 'rejected' | 'unknown',
  providerItemId: string | null = null
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState,
    providerItemId,
    reason: null,
    submittedAt: NOW,
    resolvedAt: null
  }
}

export function childRecord(
  child: Pick<AgentChildWorkView, 'id' | 'kind'> & Partial<AgentChildWorkView>
): AgentChildWorkView {
  return {
    state: 'working',
    membership: child.state === 'done' || child.state === 'idle' ? 'settled' : 'live',
    firstObservedAt: NOW,
    observedAt: NOW,
    stoppable: false,
    invocation: { invocationId: `spawn-${child.id}`, generation: 1 },
    ...child
  }
}

export const EPOCH = 'epoch-1'

export function resumableSet(input: {
  markers: AgentSessionResumeMarker[]
  items?: AgentJournalRenderItem[]
  chain?: AgentSessionRecord['providerHandleChain']
  savedByNewerOrca?: string[]
}) {
  return structuredAgentSessionResumableSet({
    markers: input.markers,
    getRecord: () => record(input.chain === undefined ? {} : { chain: input.chain }),
    supportsRecord: () => true,
    latestPrompt: () => 'fix the auth bug',
    movedOn: () => false,
    savedByNewerOrca: (sessionId) => input.savedByNewerOrca?.includes(sessionId) === true
  })
}
