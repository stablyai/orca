// Where a turn a crash cut short ends, when the provider wrote nothing while it worked.
//
// Claude reports a Bash call once when it starts and again only when it finishes, so a command
// that runs for half a minute leaves one journal row at its start. The lease renewal the host
// wrote every ten seconds is what saw the child working after that row.

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
import {
  AgentSessionAcquisitionExitUnprovenError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { resettleOpenStructuredAgentSessionConversation } from './structured-agent-session-conversation-open'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
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
/** The tool call's row: the last thing the provider wrote before the crash. */
const TOOL_STARTED_AT = 1_800_000_000_000
/** The last renewal before the crash, while the command was still running. */
const LAST_RENEWED_AT = TOOL_STARTED_AT + 25_000
/** Orca comes back an hour later. */
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
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    }
  }
}

async function seedCrashedStore(): Promise<void> {
  await seedTestAgentSessionRecordStore(root, { records: [crashedClaudeRecord()] })
  store = await openTestAgentSessionRecordStore(root)
}

/** A running turn whose only row after its start is a Bash call that never reported back, for a
 *  send the provider never acknowledged: the reopen settles it at the fence after the crash. */
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

/** What a client reads over the wire. */
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
  await host?.flushAllStreamedEvents()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('a turn a crash cut short mid-tool', () => {
  it('ends at the last renewal, not at the tool call the provider last reported', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })

    await host.restoreReadableSessions()

    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'pid-absent',
      observedAt: RELAUNCHED_AT,
      lastProvenAliveAt: LAST_RENEWED_AT
    })
    expect(await settledTurn()).toMatchObject({
      state: 'interrupted',
      completedAt: LAST_RENEWED_AT
    })
    // "Worked for 27s", where the tool call's row alone reads 2s.
    const [timing] = selectStructuredAgentTurnTimings(
      (await host.journalSnapshot(SESSION)).items
    ).values()
    expect(completedStructuredAgentTurnSeconds(timing)).toBe(27)
  })

  // The turn bar reads like a finished turn, so this row is the one place the chat says why.
  it('explains the cut once, with one notice row and a turn bar that does not repeat it', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })

    await host.restoreReadableSessions()

    const { items } = await host.journalSnapshot(SESSION)
    // As a reader's transcript shows it: the stored row is the explanation, so none is derived.
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
    // The orphan is alive at relaunch, but its output went nowhere: none of that is work shown.
    let alive = true
    const probeOwner = async (): Promise<AgentSessionOwnerProbe> =>
      alive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' }
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })
    openHost({ probeOwner, stopOwnerProcess })

    await host.restoreReadableSessions()

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

/** Every turn state a subscriber was sent, in order: snapshots, then live batches. */
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

/** Runs whatever this session's serialize already has queued. */
function drainSession(): Promise<void> {
  return host.collaboratorsForTests().serialize(SESSION, async () => {})
}

// On desktop the chat on screen at relaunch opens before the startup reconcile has probed its owner,
// so the open can only call the turn unverifiable; the proof, whoever writes it, then revises it.
describe('a turn a read reached before the reconcile proved its owner dead', () => {
  it('reads unverifiable, then interrupted at the last renewal, and a subscriber is sent both', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await host.subscribe({
      id: 'reader-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    expect(await settledTurn()).toEqual(UNVERIFIABLE_TURN)

    await host.reconcileRestartLeases()
    await drainSession()

    // A paired or phone client learns of the revision through the ordinary journal publish.
    await vi.waitFor(() =>
      expect(turnStatesSent(events)).toMatchObject([
        { state: 'unverifiable' },
        { state: 'interrupted', completedAt: LAST_RENEWED_AT }
      ])
    )
    const { items } = await host.journalSnapshot(SESSION)
    const [timing] = selectStructuredAgentTurnTimings(items).values()
    expect(completedStructuredAgentTurnSeconds(timing)).toBe(27)
    expect(items.filter((item) => item.body.kind === 'status')).toHaveLength(1)
    unsubscribe()
  })

  it('reports the revision to the status feed as an interruption, which the chat folds as worked', async () => {
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
    expect(outcomes().at(-1)).toBe('unconfirmed')

    await host.reconcileRestartLeases()
    await drainSession()

    // The sidebar's red Failed until seen; the turn folds as "Worked for 27s" beside its notice row.
    await vi.waitFor(() => expect(outcomes().at(-1)).toBe('interruption'))
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
    await host.restoreReadableSessions()

    expect(await host.journalSnapshot(SESSION)).toEqual(settled)
  })

  it('revises it when recovery stops a child that outlived Orca, with no send', async () => {
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
    expect(await settledTurn()).toEqual(UNVERIFIABLE_TURN)

    // The reconcile only parks the live orphan in recovery; recovery's stop is what proves it gone.
    await host.restoreReadableSessions()
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
        // The new child is already working when its start lands, ahead of the queued revision.
        events?.appendItem(
          { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'uuid-turn-2' },
          { kind: 'turn', turnId: 'turn-2', state: 'running', startedAt: RELAUNCHED_AT },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return {
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

    // The start runs the reconcile itself, so the revision it queues waits behind the start.
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

  it('stays unverifiable when the revision cannot be written, and a later open revises it', async () => {
    let now = RELAUNCHED_AT
    const log = recordingStructuredAgentSessionLogger()
    openHost({
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      now: () => now,
      logger: log.logger
    })
    await host.history({ sessionId: SESSION, direction: 'tail' })
    const { journal } = host.collaboratorsForTests().sessions.get(SESSION)!
    vi.spyOn(journal, 'appendLifecycleBatch').mockRejectedValueOnce(new Error('disk full'))

    await host.reconcileRestartLeases()
    await drainSession()

    expect(log.scopes()).toEqual(['open-dead-generation'])
    expect(await settledTurn()).toEqual(UNVERIFIABLE_TURN)
    // The proof is durable on the record, so the next open converges.
    now += STRUCTURED_AGENT_SESSION_IDLE_MS + 1
    await host.collaboratorsForTests().lifetime.idleSweep.tick()
    expect(host.hasSession(SESSION)).toBe(false)
    expect(await settledTurn()).toMatchObject({
      state: 'interrupted',
      completedAt: LAST_RENEWED_AT
    })
  })
})

/** A relaunched host whose first start after the crash, at fence 15, fails with `failure`; every
 *  later start succeeds. The crashed owner, and any child left behind, probe gone. */
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

/** The turn as the crashed owner left it, with no end: nothing proves when that owner stopped. */
const UNVERIFIABLE_TURN = {
  turnId: 'turn-1',
  state: 'unverifiable',
  startedAt: TOOL_STARTED_AT - 2_000
}

// The relaunch proved the fence-13 owner gone, but a start reserving fence 15 clears that proof
// before the turn is settled; what the record holds afterwards is about the start's own child.
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
    // Recovery records that child's death, then the client retries at the fence it was told.
    await expect(attach(15)).resolves.toMatchObject({ refusal: { currentFence: 16 } })
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      ownerFence: 15,
      lastProvenAliveAt: RELAUNCHED_AT
    })
    await expect(attach(16)).resolves.toMatchObject({ ok: true })

    expect(await settledTurn()).toEqual(UNVERIFIABLE_TURN)
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

    // Main ended it at the failed start, an hour after the crash, with the start's reason.
    expect(await settledTurn()).toEqual(UNVERIFIABLE_TURN)
  })
})
