import { openTestChats } from './structured-agent-session-open-test-chats.test-support'
// Quiet tools may emit only start/end rows; pre-crash lease renewal supplies the latest observed work time.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionStatusSummary,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { describeNativeChatTurnStatus } from '../../../shared/native-chat-turn-status'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentTurnTimings
} from '../../../shared/structured-agent-session-turn-timing'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { JournalLifecycleBatchAppender } from '../agent-session-journal/journal-lifecycle-batch-appender'
import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import {
  AgentSessionAcquisitionExitUnprovenError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { resettleOpenStructuredAgentSessionConversation } from './structured-agent-session-conversation-open'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat/transcript/native-chat-cut-turn-notice'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import { beginAgentSessionRuntimeRecord } from '../../runtime/agent-session-runtime-end-record'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  hostTestAttachParams,
  HOST_TEST_LOCATION as LOCATION,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const PROVIDER_SESSION = 'provider-session-alpha-1'
const TOOL_STARTED_AT = 1_800_000_000_000
const LAST_RENEWED_AT = TOOL_STARTED_AT + 25_000
const RELAUNCHED_AT = TOOL_STARTED_AT + 60 * 60 * 1000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost

function crashedClaudeRecord(): AgentSessionRecord {
  const linkId = 'claude-13-link'
  return {
    schemaVersion: 2,
    sessionId: SESSION,
    location: LOCATION,
    provider: 'claude',
    providerHandleChain: [
      {
        linkId,
        handle: claudeProviderHandle(PROVIDER_SESSION, null),
        origin: 'created',
        mintedAtFence: 13,
        observedAt: TOOL_STARTED_AT - 60_000
      }
    ],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    createdAt: TOOL_STARTED_AT - 60_000,
    updatedAt: LAST_RENEWED_AT,
    lease: {
      sessionId: SESSION,
      runtimeKind: 'native',
      runtimeFence: 13,
      handoffStage: null,
      provenHandleLinkId: linkId,
      ownerProcess: {
        hostId: 'local',
        pid: 12_546,
        processStartTimeMs: TOOL_STARTED_AT - 60_000,
        spawnToken: 'spawn-crashed'
      },
      reservedSpawnToken: 'spawn-crashed',
      leaseDeadlineAt: LAST_RENEWED_AT + 30_000,
      lastRenewedAt: LAST_RENEWED_AT,
      handoffOperationId: null,
      claimKeyId: 'key-1',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    }
  }
}

async function seedCrashedStore(): Promise<void> {
  await seedTestAgentSessionRecordStore(root, { records: [crashedClaudeRecord()] })
  store = await openTestAgentSessionRecordStore(root, { legacySessionTabIds: [SESSION] })
}

/** Seed an unacknowledged send with a started Bash call and no completion. */
async function seedClaudeToolTurn(): Promise<void> {
  let now = TOOL_STARTED_AT - 2_000
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'claude',
      providerHandle: claudeProviderHandle(PROVIDER_SESSION, null)
    },
    database: openTestJournalHostDatabase(root),
    now: () => now
  })
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: '0'.repeat(64),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run the loop' }] },
    fence: 13
  })
  const turnIdentity = {
    provider: 'claude' as const,
    sessionId: PROVIDER_SESSION,
    uuid: 'uuid-turn'
  }
  const turnScope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(turnIdentity) }
  await journal.appendItem(
    turnIdentity,
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: now },
    { fence: 13, turnScope }
  )
  now = TOOL_STARTED_AT
  await journal.appendItem(
    { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'uuid-bash' },
    {
      kind: 'tool-call',
      name: 'Bash',
      input: { command: 'for i in $(seq 90); do sleep 1; done' },
      state: 'running'
    },
    { fence: 13, turnScope }
  )
  await journal.close()
}

function openHost(overrides: Partial<StructuredAgentSessionHostDeps>): void {
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      open: async () => ({
        reportedOptions: { model: '' }
      }),
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-new',
    now: () => RELAUNCHED_AT,
    ...overrides
  })
}

const INTERRUPTED_TURN = { turnId: 'turn-1', state: 'interrupted', completedAt: LAST_RENEWED_AT }

async function settledTurn() {
  return (await host.journalSnapshot(SESSION)).items
    .map((item) => readAgentJournalTurn(item.body))
    .find(Boolean)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-crash-turn-end-'))
  await seedCrashedStore()
  await seedClaudeToolTurn()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host?.flushAllStreamedEvents()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('a turn a crash cut short mid-tool', () => {
  it('ends at the last renewal, not at the tool call the provider last reported', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })

    await openTestChats(host)

    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'pid-absent',
      observedAt: RELAUNCHED_AT,
      lastProvenAliveAt: LAST_RENEWED_AT
    })
    expect(await settledTurn()).toMatchObject({
      state: 'interrupted',
      completedAt: LAST_RENEWED_AT
    })
    // Lease renewal proves 27s of work; the last provider row alone accounts for only 2s.
    const [timing] = selectStructuredAgentTurnTimings(
      (await host.journalSnapshot(SESSION)).items
    ).values()
    expect(completedStructuredAgentTurnSeconds(timing)).toBe(27)
  })

  it('explains the cut once, with one notice row and a turn bar that does not repeat it', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })

    await openTestChats(host)

    const { items } = await host.journalSnapshot(SESSION)
    const statusRows = withNativeChatCutTurnNotices(items, { agentName: 'Claude' }).flatMap(
      (item) => (item.body.kind === 'status' ? [item.body] : [])
    )
    expect(statusRows).toEqual([
      expect.objectContaining({
        text: 'Claude stopped while this response was in progress. You can continue in this conversation.',
        failure: expect.objectContaining({ kind: 'providerExited' }),
        tone: 'error'
      })
    ])
    const [timing] = selectStructuredAgentTurnTimings(items).values()
    expect(
      describeNativeChatTurnStatus({
        elapsedSeconds: 0,
        workedSeconds: completedStructuredAgentTurnSeconds(timing),
        verdict: timing?.verdict
      })
    ).toEqual({ key: 'workedFor', duration: '27s' })
  })

  it('ends at the pre-crash renewal when the child outlived Orca and recovery stopped it', async () => {
    // Orphan output after host death cannot count as work the chat showed.
    let alive = true
    const probeOwner = async (): Promise<AgentSessionOwnerProbe> =>
      alive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' }
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })
    openHost({ probeOwner, stopOwnerProcess })

    await openTestChats(host)

    expect(stopOwnerProcess).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'pid-absent',
      lastProvenAliveAt: LAST_RENEWED_AT
    })
    expect(await settledTurn()).toMatchObject({
      state: 'interrupted',
      completedAt: LAST_RENEWED_AT
    })
  })
})

function turnStatesSent(events: readonly AgentSessionSubscribeEvent[]) {
  return events
    .flatMap((event) =>
      event.type === 'snapshot' ? event.page.items : event.type === 'batch' ? event.batch.items : []
    )
    .flatMap((item) => readAgentJournalTurn(item.body) ?? [])
}

function attach(fence: number) {
  return host.attach(
    { callerKey: 'client-1' },
    hostTestAttachParams(fence, {
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION, leafUuid: null }
    })
  )
}

function drainSession(): Promise<void> {
  return host.collaboratorsForTests().serialize(SESSION, async () => {})
}

// Visible chats may open before ownership probes; replaced-runtime evidence already ends old work.
describe('a turn a read reached before the reconcile proved its owner dead', () => {
  it('reads interrupted at the last renewal from the first open, and a subscriber is sent it once', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await host.subscribe({
      id: 'reader-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    expect(await settledTurn()).toMatchObject(INTERRUPTED_TURN)

    await host.reconcileRestartLeases()
    await drainSession()

    expect(turnStatesSent(events)).toMatchObject([INTERRUPTED_TURN])
    const { items } = await host.journalSnapshot(SESSION)
    const [timing] = selectStructuredAgentTurnTimings(items).values()
    expect(completedStructuredAgentTurnSeconds(timing)).toBe(27)
    expect(items.filter((item) => item.body.kind === 'status')).toHaveLength(1)
    unsubscribe()
  })

  it('reports the open to the status feed as an interruption, which the chat folds as worked', async () => {
    const published: AgentSessionStatusSummary[] = []
    openHost({
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      statusSink: { publish: (summary) => published.push(summary), forget: () => {} }
    })
    await host.history({ sessionId: SESSION, direction: 'tail' })
    const outcomes = () =>
      published
        .filter((summary) => summary.sessionId === SESSION && summary.turnOutcome)
        .map((summary) => summary.turnOutcome)
    expect(outcomes()).toEqual(['interruption'])

    await host.reconcileRestartLeases()
    await drainSession()

    expect(outcomes().at(-1)).toBe('interruption')
    const [timing] = selectStructuredAgentTurnTimings(
      (await host.journalSnapshot(SESSION)).items
    ).values()
    expect(
      describeNativeChatTurnStatus({
        elapsedSeconds: 0,
        workedSeconds: completedStructuredAgentTurnSeconds(timing),
        verdict: timing?.verdict
      })
    ).toEqual({ key: 'workedFor', duration: '27s' })
  })

  it('explains the turn it cut, so the cut reads once and offers Continue', async () => {
    const crashed = crashedClaudeRecord()
    const ownerProcess = crashed.lease.ownerProcess
    if (!ownerProcess) {
      throw new Error('the crashed record has no owner')
    }
    await seedTestAgentSessionRecordStore(root, {
      records: [
        {
          ...crashed,
          lease: { ...crashed.lease, ownerProcess: { ...ownerProcess, runtime: 'runtime-crashed' } }
        }
      ]
    })
    beginAgentSessionRuntimeRecord(root, 'runtime-crashed', TOOL_STARTED_AT - 60_000)
    store = await openTestAgentSessionRecordStore(root, { legacySessionTabIds: [SESSION] })
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
    expect(await settledTurn()).toMatchObject(INTERRUPTED_TURN)

    await host.reconcileRestartLeases()
    await drainSession()

    const { items } = await host.journalSnapshot(SESSION)
    const turnItemId = items.find((item) => item.body.kind === 'turn')?.itemId
    expect(items.flatMap((item) => (item.body.kind === 'status' ? [item.turnScope] : []))).toEqual([
      { kind: 'turn', turnItemId }
    ])
    expect(latestNativeChatOrcaStopCut(items, [])).toEqual({ turnItemId, cause: 'crash' })
    const readerRows = withNativeChatCutTurnNotices(items, { agentName: 'Claude' }).filter(
      (item) => item.body.kind === 'status'
    )
    expect(readerRows).toHaveLength(1)
  })

  it('revises nothing twice, whoever re-runs the settle', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
    await host.history({ sessionId: SESSION, direction: 'tail' })
    await host.reconcileRestartLeases()
    await drainSession()
    const settled = await host.journalSnapshot(SESSION)

    await host
      .collaboratorsForTests()
      .serialize(SESSION, () =>
        resettleOpenStructuredAgentSessionConversation(
          host.deps,
          SESSION,
          host.collaboratorsForTests().sessions.get(SESSION)
        )
      )
    await openTestChats(host)

    expect(await host.journalSnapshot(SESSION)).toEqual(settled)
  })

  it('ends it at the last renewal although recovery stops a child that outlived Orca later', async () => {
    let alive = true
    const probeOwner = async (): Promise<AgentSessionOwnerProbe> =>
      alive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' }
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })
    const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>()
    openHost({
      adapter: {
        open: async () => ({
          reportedOptions: { model: '' }
        }),
        acquire,
        dispatch: vi.fn(),
        cancelTurn: vi.fn(),
        answerPrompt: vi.fn(),
        setOption: vi.fn(),
        supportsCreate: () => true
      },
      probeOwner,
      stopOwnerProcess
    })
    await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(await settledTurn()).toMatchObject(INTERRUPTED_TURN)

    // Reconciliation parks live orphans; recovery Stop supplies exit proof.
    await openTestChats(host)
    await drainSession()

    expect(stopOwnerProcess).toHaveBeenCalledOnce()
    expect(acquire).not.toHaveBeenCalled()
    expect(await settledTurn()).toMatchObject({
      state: 'interrupted',
      completedAt: LAST_RENEWED_AT
    })
  })

  it('never touches the turn a start after the crash is writing', async () => {
    const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(
      async ({ fence, spawnToken, onSpawned, events }) => {
        const process = {
          hostId: 'local',
          pid: 8_000,
          processStartTimeMs: RELAUNCHED_AT,
          spawnToken
        }
        await onSpawned?.(process)
        // Queue new work before the prior generation’s pending revision.
        events?.appendItem(
          { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'uuid-turn-2' },
          { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: RELAUNCHED_AT },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return {
          acquisitionGeneration: globalThis.crypto.randomUUID(),
          process,
          link: {
            linkId: `claude-${fence}-link`,
            handle: claudeProviderHandle(PROVIDER_SESSION, null),
            origin: 'resumed',
            mintedAtFence: fence,
            observedAt: RELAUNCHED_AT
          }
        }
      }
    )
    openHost({
      adapter: {
        open: async () => ({
          reportedOptions: { model: '' }
        }),
        acquire,
        dispatch: vi.fn(),
        cancelTurn: vi.fn(),
        answerPrompt: vi.fn(),
        setOption: vi.fn(),
        supportsCreate: () => true
      },
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    await host.history({ sessionId: SESSION, direction: 'tail' })

    await expect(attach(14)).resolves.toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    await drainSession()

    const turns = (await host.journalSnapshot(SESSION)).items.flatMap(
      (item) => readAgentJournalTurn(item.body) ?? []
    )
    expect(turns).toMatchObject([
      { turnId: 'turn-1', state: 'interrupted', completedAt: LAST_RENEWED_AT },
      { turnId: 'turn-2', state: 'running' }
    ])
  })

  it('stays running when the open cannot write its settle, and a later open settles it', async () => {
    let now = RELAUNCHED_AT
    const log = recordingStructuredAgentSessionLogger()
    const append = JournalLifecycleBatchAppender.prototype.appendPlanned
    let refused = false
    vi.spyOn(JournalLifecycleBatchAppender.prototype, 'appendPlanned').mockImplementation(function (
      this: JournalLifecycleBatchAppender,
      input
    ) {
      if (!refused && input.settlementId.startsWith(STALE_SESSION_ROW_PREFIX)) {
        refused = true
        return Promise.reject(new Error('disk full'))
      }
      return append.call(this, input)
    })
    openHost({ now: () => now, logger: log.logger })

    await host.history({ sessionId: SESSION, direction: 'tail' })

    expect(log.scopes()).toEqual(['open-dead-generation'])
    expect(await settledTurn()).toMatchObject({ turnId: 'turn-1', state: 'running' })
    now += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
    await host.collaboratorsForTests().lifetime.idleSweep.tick()
    expect(host.hasSession(SESSION)).toBe(false)
    expect(await settledTurn()).toMatchObject(INTERRUPTED_TURN)
  })
})

/** Fail only the first post-crash start; old owners probe gone. */
async function hostWithFailingFirstStart(failure: Error) {
  let now = RELAUNCHED_AT
  const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(
    async ({ fence, spawnToken, onSpawned }) => {
      const process = { hostId: 'local', pid: 7_000 + fence, processStartTimeMs: now, spawnToken }
      await onSpawned?.(process)
      if (fence === 15) {
        throw failure
      }
      return {
        acquisitionGeneration: globalThis.crypto.randomUUID(),
        process,
        link: {
          linkId: `claude-${fence}-link`,
          handle: claudeProviderHandle(PROVIDER_SESSION, null),
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: now
        }
      }
    }
  )
  openHost({
    adapter: {
      open: async () => ({
        reportedOptions: { model: '' }
      }),
      acquire,
      releaseAcquisition: async () => true,
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    now: () => now
  })
  await host.reconcileRestartLeases()
  return {
    attach,
    advance: (ms: number) => {
      now += ms
    }
  }
}

// A newer reservation clears old death evidence; classify the old turn by its replaced runtime’s renewal,
// never the later child’s death or failed-start reason.
describe('a turn a newer start could not settle before it failed', () => {
  it('is not judged by the death of the child it left for recovery', async () => {
    const { attach, advance } = await hostWithFailingFirstStart(
      new AgentSessionAcquisitionExitUnprovenError(new Error('hung'))
    )

    await attach(14).catch(() => undefined)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 15,
      handoffStage: 'recovering',
      lastRenewedAt: RELAUNCHED_AT
    })
    advance(60_000)
    await expect(attach(15)).resolves.toMatchObject({ refusal: { currentFence: 16 } })
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      ownerFence: 15,
      lastProvenAliveAt: RELAUNCHED_AT
    })
    await expect(attach(16)).resolves.toMatchObject({ ok: true })

    expect(await settledTurn()).toMatchObject(INTERRUPTED_TURN)
  })

  it('is not judged by the watched exit of a start that failed', async () => {
    const { attach, advance } = await hostWithFailingFirstStart(new Error('claude exited (code 1)'))

    await expect(attach(14)).resolves.toMatchObject({ ok: false })
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'exit-observed',
      ownerFence: 15,
      observedAt: RELAUNCHED_AT
    })
    advance(60_000)
    await expect(attach(16)).resolves.toMatchObject({ ok: true })

    expect(await settledTurn()).toMatchObject(INTERRUPTED_TURN)
  })
})
