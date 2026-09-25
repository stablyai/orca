// A real host over a real store and journal, with a scripted provider and a clock the test moves,
// for the tests of a conversation that outlives its agent. The idle sweep runs on its own short
// interval; a test moves `clock.now` past the idle window and waits for the outcome.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  STRUCTURED_AGENT_SESSION_IDLE_MS,
  StructuredAgentSessionIdleSweep
} from './structured-agent-session-idle-sweep'

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
  backgroundTaskState: Mock<NonNullable<StructuredAgentSessionAdapter['backgroundTaskState']>>
  readOptions: Mock<NonNullable<StructuredAgentSessionAdapter['readOptions']>>
}

export type RestTestRig = {
  root: string
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  adapter: RestTestAdapter
  clock: { now: number }
  statusEvents: AgentSessionStatusEvent[]
  sink: { publish: Mock; forget: Mock }
  /** Opens a fresh host over the same store and journals: what a restart leaves behind. */
  restart: (deps?: Partial<StructuredAgentSessionHostDeps>) => Promise<StructuredAgentSessionHost>
  dispose: () => Promise<void>
}

let ordinal = 0
let generations = 0

export function acceptedDispatch(): AgentSessionDispatchOutcome {
  ordinal += 1
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: `turn-${ordinal}`, ordinal }
  }
}

export function restTestSend(
  text: string,
  fence = 1
): { envelope: AgentSessionMutationEnvelope; body: AgentJournalMessageItem } {
  const body = hostTestMessage(text)
  return {
    body,
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
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

export async function createRestTestRig(
  deps: Partial<StructuredAgentSessionHostDeps> = {}
): Promise<RestTestRig> {
  resetHostTestOperationIds()
  ordinal = 0
  const root = await mkdtemp(join(tmpdir(), 'orca-rest-'))
  const clock = { now: HOST_TEST_NOW }
  const statusEvents: AgentSessionStatusEvent[] = []
  const sink = { publish: vi.fn(), forget: vi.fn() }
  let store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const adapter: RestTestAdapter = {
    acquire: vi.fn(async ({ fence, spawnToken }) => ({
      acquisitionGeneration: `generation-${++generations}`,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex' as const, threadId: THREAD },
        origin: store.getRecord(SESSION)?.providerHandleChain.length
          ? ('resumed' as const)
          : ('created' as const),
        mintedAtFence: fence,
        observedAt: clock.now
      }
    })),
    closeSession: vi.fn(async () => true),
    dispatch: vi.fn(async () => acceptedDispatch()),
    acknowledgeSessionRelease: vi.fn(),
    backgroundTaskState: vi.fn(() => undefined),
    readOptions: vi.fn(async () => ({ models: [], current: { model: 'gpt-live' } }))
  }
  const hostFor = (overrides: Partial<StructuredAgentSessionHostDeps>) =>
    new StructuredAgentSessionHost({
      store,
      adapter: {
        ...adapter,
        releaseAcquisition: vi.fn(async () => true),
        cancelTurn: async () => ({ cancelled: true }),
        answerPrompt: async ({ commit }) => commit(),
        setOption: async () => undefined
      },
      journalRoot: root,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      now: () => clock.now,
      statusSink: sink,
      idleSweep: { intervalMs: SWEEP_INTERVAL_MS },
      ...deps,
      ...overrides
    })
  const rig: RestTestRig = {
    root,
    store,
    host: hostFor({}),
    adapter,
    clock,
    statusEvents,
    sink,
    restart: async (overrides = {}) => {
      await rig.host.flushAllStreamedEvents().catch(() => undefined)
      store = await AgentSessionRecordStore.open({
        directory: join(root, 'store'),
        hostId: 'local'
      })
      rig.store = store
      rig.host = hostFor(overrides)
      rig.host.subscribeStatus({ id: 'status', emit: (event) => statusEvents.push(event) })
      return rig.host
    },
    dispose: async () => {
      await rig.host.flushAllStreamedEvents().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }
  rig.host.subscribeStatus({ id: 'status', emit: (event) => statusEvents.push(event) })
  return rig
}

/** Creates the chat, lists its tab, and sends one message so its journal is on disk. */
export async function foundRestTestChat(rig: RestTestRig): Promise<void> {
  const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
  if (!attached.ok) {
    throw new Error(`attach refused: ${attached.refusal.code}`)
  }
  await rig.store.setSessionTabVisibility(SESSION, true)
  const sent = await rig.host.send(REST_TEST_CALLER, restTestSend('hello', attached.fence))
  if (!sent.ok) {
    throw new Error(`send refused: ${sent.refusal.code}`)
  }
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalled())
}

/** Runs one sweep pass now, for a test that set `idleSweep.intervalMs` out of reach. */
export function sweepOnce(host: StructuredAgentSessionHost): Promise<void> {
  const lifetime: unknown = Reflect.get(host, 'lifetime')
  const sweep: unknown =
    typeof lifetime === 'object' && lifetime !== null ? Reflect.get(lifetime, 'idleSweep') : null
  if (!(sweep instanceof StructuredAgentSessionIdleSweep)) {
    throw new Error('the host has no idle sweep')
  }
  return sweep.tick()
}

/** Waits long enough for several sweep ticks to have run. */
export function sweepTicks(count = 6): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS * count))
}

export { SESSION as REST_TEST_SESSION, THREAD as REST_TEST_THREAD }
