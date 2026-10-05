// A real host over a real store and journal, with a scripted provider and a clock the test moves,
// for the tests of a conversation that outlives its agent and of what a restarted host owes. The
// idle sweep runs on its own short interval; a test moves `clock.now` past the idle window and
// waits for the outcome. Every journal open calls `historyFilePath` once, so that mock is the open
// counter, and holding it holds the open.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

export const REST_TEST_CALLER = { callerKey: 'client-1' }
export const IDLE_MS = STRUCTURED_AGENT_SESSION_IDLE_MS
export const SWEEP_INTERVAL_MS = 5

export type RestTestAdapter = {
  acquire: Mock<StructuredAgentSessionAdapter['acquire']>
  closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
  dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
  acknowledgeSessionRelease: Mock<
    NonNullable<StructuredAgentSessionAdapter['acknowledgeSessionRelease']>
  >
  holdsDispatch: Mock<NonNullable<StructuredAgentSessionAdapter['holdsDispatch']>>
  readOptions: Mock<NonNullable<StructuredAgentSessionAdapter['readOptions']>>
  /** Called once per journal open, with the session id; replace its implementation to hold one. */
  historyFilePath: Mock<(sessionId: string) => Promise<string | null>>
}

export type RestTestRig = {
  root: string
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  adapter: RestTestAdapter
  clock: { now: number }
  statusEvents: AgentSessionStatusEvent[]
  /** `readChildWork` serves the session's child records, as the host's store does. */
  sink: {
    publish: Mock
    forget: Mock
    readChildWork: Mock<(subject: unknown) => AgentChildWorkView[]>
  }
  probeOwner: Mock<(record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>>
  /** Workspaces this host's adapter does not serve, as a platform gate would. */
  unsupportedWorkspaceIds: Set<string>
  /** Opens a fresh host over the same store and journals: what a restart leaves behind. */
  restart: (deps?: Partial<StructuredAgentSessionHostDeps>) => Promise<StructuredAgentSessionHost>
  /** A crash: nothing settles or flushes; the process's timers and handles simply stop. */
  crash: () => Promise<void>
  /** A new app run over the same files, with no flush first; the mocks and status stream start
   *  empty, so they hold what the new run saw and nothing the previous one did. */
  boot: (deps?: Partial<StructuredAgentSessionHostDeps>) => Promise<StructuredAgentSessionHost>
  dispose: () => Promise<void>
}

let ordinal = 0
let generations = 0

/** The rig's own chat keeps the shared test thread; any other chat gets a thread of its own. */
function restTestThread(sessionId: string): string {
  return sessionId === SESSION ? THREAD : `thread-${sessionId}`
}

export function acceptedDispatch(sessionId = SESSION): AgentSessionDispatchOutcome {
  ordinal += 1
  return {
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: restTestThread(sessionId),
      turnId: `turn-${ordinal}`,
      ordinal
    }
  }
}

export function restTestSend(
  text: string,
  fence: number | null = 1,
  sessionId = SESSION
): { envelope: AgentSessionMutationEnvelope; body: AgentJournalMessageItem } {
  const body = hostTestMessage(text)
  return {
    body,
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId,
        fields: { body }
      })
    }
  }
}

/** Every item and submission a reader was sent, whatever frame carried it. */
export function readerSaw(events: readonly AgentSessionSubscribeEvent[]) {
  const items = events.flatMap((event) =>
    event.type === 'batch' ? event.batch.items : event.type === 'end' ? [] : event.page.items
  )
  const submissions = events.flatMap((event) =>
    event.type === 'batch' ? event.batch.submissions : []
  )
  return {
    texts: items.flatMap((item) =>
      item.body.kind === 'message'
        ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    ),
    submissions
  }
}

export function collectSubscriber(): {
  events: AgentSessionSubscribeEvent[]
  emit: (event: AgentSessionSubscribeEvent) => void
} {
  const events: AgentSessionSubscribeEvent[] = []
  return { events, emit: (event) => events.push(event) }
}

/** `root` is handed to the rig, which removes it on dispose; by default it makes its own. */
export async function createRestTestRig(
  deps: Partial<StructuredAgentSessionHostDeps> = {},
  options: { root?: string } = {}
): Promise<RestTestRig> {
  resetHostTestOperationIds()
  ordinal = 0
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'orca-rest-')))
  const clock = { now: HOST_TEST_NOW }
  const statusEvents: AgentSessionStatusEvent[] = []
  const sink: RestTestRig['sink'] = {
    publish: vi.fn(),
    forget: vi.fn(),
    readChildWork: vi.fn((): AgentChildWorkView[] => [])
  }
  const probeOwner: RestTestRig['probeOwner'] = vi.fn(async () => ({ outcome: 'pid-absent' }))
  const unsupportedWorkspaceIds = new Set<string>()
  const openStore = () => openTestAgentSessionRecordStore(root)
  let store = await openStore()
  const adapter: RestTestAdapter = {
    acquire: vi.fn(async ({ fence, spawnToken, identity }) => ({
      acquisitionGeneration: `generation-${++generations}`,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      link: {
        linkId:
          identity.sessionId === SESSION ? `link-${fence}` : `link-${identity.sessionId}-${fence}`,
        handle: { provider: 'codex' as const, threadId: restTestThread(identity.sessionId) },
        origin: store.getRecord(identity.sessionId)?.providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: clock.now
      }
    })),
    closeSession: vi.fn(async () => true),
    dispatch: vi.fn(async (input) => acceptedDispatch(input.sessionId)),
    acknowledgeSessionRelease: vi.fn(),
    holdsDispatch: vi.fn(() => false),
    readOptions: vi.fn(async () => ({ models: [], current: { model: 'gpt-live' } })),
    historyFilePath: vi.fn(async (_sessionId: string): Promise<string | null> => null)
  }
  const hostFor = (overrides: Partial<StructuredAgentSessionHostDeps>) => {
    const host = new StructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: {
        ...adapter,
        historyFilePath: ({ identity }) => adapter.historyFilePath(identity.sessionId),
        supportsCreate: (location, agent) =>
          agent === 'codex' && !unsupportedWorkspaceIds.has(location.workspaceId),
        releaseAcquisition: vi.fn(async () => true),
        cancelTurn: async () => ({ cancelled: true }),
        answerPrompt: async ({ commit }) => commit(),
        setOption: async () => undefined
      },
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      probeOwner,
      now: () => clock.now,
      statusSink: sink,
      idleSweep: { intervalMs: SWEEP_INTERVAL_MS },
      ...deps,
      ...overrides
    })
    host.subscribeStatus({ id: 'status', emit: (event) => statusEvents.push(event) })
    return host
  }
  const reopen = async (overrides: Partial<StructuredAgentSessionHostDeps>) => {
    store = await openStore()
    rig.store = store
    rig.host = hostFor(overrides)
    return rig.host
  }
  const rig: RestTestRig = {
    root,
    store,
    host: hostFor({}),
    adapter,
    clock,
    statusEvents,
    sink,
    probeOwner,
    unsupportedWorkspaceIds,
    restart: async (overrides = {}) => {
      await rig.host.flushAllStreamedEvents().catch(() => undefined)
      return reopen(overrides)
    },
    crash: async () => {
      const { runtimeState, lifetime, sessions } = rig.host.collaboratorsForTests()
      await runtimeState.stopLeaseRenewal()
      lifetime.dispose()
      for (const session of sessions.values()) {
        await session.journal.close()
      }
      sessions.clear()
    },
    boot: (overrides = {}) => {
      for (const mock of [adapter.historyFilePath, adapter.acquire, adapter.dispatch, probeOwner]) {
        mock.mockClear()
      }
      sink.publish.mockClear()
      sink.forget.mockClear()
      statusEvents.length = 0
      return reopen(overrides)
    },
    dispose: async () => {
      await rig.host.flushAllStreamedEvents().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }
  return rig
}

/** Creates the chat, lists its tab unless told not to, and sends `message` when one is given,
 *  waiting for its dispatch. */
export async function restTestChat(
  rig: RestTestRig,
  sessionId: string,
  options: { workspaceId?: string; listed?: boolean; message?: string } = {}
): Promise<void> {
  const fence = rig.store.getRecord(sessionId)?.lease.runtimeFence ?? null
  const attached = await rig.host.attach(
    REST_TEST_CALLER,
    hostTestAttachParams(fence, {
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fence,
        payloadFingerprint: ''
      },
      location: { ...HOST_TEST_LOCATION, workspaceId: options.workspaceId ?? 'workspace-1' },
      providerHandle: { kind: 'codex', threadId: restTestThread(sessionId) }
    })
  )
  if (!attached.ok) {
    throw new Error(`attach refused: ${attached.refusal.code}`)
  }
  if (options.listed !== false) {
    await rig.store.setSessionTabVisibility(sessionId, true)
  }
  if (options.message === undefined) {
    return
  }
  const { dispatch } = rig.adapter
  const dispatched = dispatch.mock.calls.length
  const params = restTestSend(options.message, attached.fence, sessionId)
  const sent = await rig.host.send(REST_TEST_CALLER, params)
  if (!sent.ok) {
    throw new Error(`send refused: ${sent.refusal.code}`)
  }
  await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThan(dispatched), {
    timeout: 10_000
  })
}

/** Creates the rig's own chat, lists its tab, and sends one message so its journal is on disk. */
export function foundRestTestChat(rig: RestTestRig): Promise<void> {
  return restTestChat(rig, SESSION, { message: 'hello' })
}

/** A send from a client that has not attached this run, so it names no fence. */
export function sendRestTestMessage(rig: RestTestRig, sessionId: string, text: string) {
  return rig.host.send(REST_TEST_CALLER, restTestSend(text, null, sessionId))
}

/** Runs one sweep pass now, for a test that set `idleSweep.intervalMs` out of reach. */
export function sweepOnce(host: StructuredAgentSessionHost): Promise<void> {
  return host.collaboratorsForTests().lifetime.idleSweep.tick()
}

/** Waits long enough for several sweep ticks to have run. */
export function sweepTicks(count = 6): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS * count))
}

export { SESSION as REST_TEST_SESSION, THREAD as REST_TEST_THREAD }
