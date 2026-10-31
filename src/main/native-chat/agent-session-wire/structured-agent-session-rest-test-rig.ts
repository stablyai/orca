import { createRestTestOwnership } from './structured-agent-session-rest-test-ownership'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionHeldStarts } from './structured-agent-session-held-start.test-support'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { STRUCTURED_AGENT_SESSION_IDLE_MS } from './structured-agent-session-idle-sweep'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionJournalOptions } from '../agent-session-journal/journal-store-contracts'
import type { Mock } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

export const REST_TEST_CALLER = { callerKey: 'client-1' }
export const IDLE_MS = STRUCTURED_AGENT_SESSION_IDLE_MS
export const SWEEP_INTERVAL_MS = 5

export type RestTestAdapter = {
  open: StructuredAgentSessionAdapter['open']
  acquire: Mock<StructuredAgentSessionAdapter['acquire']>
  closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
  dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
  acknowledgeSessionRelease: Mock<
    NonNullable<StructuredAgentSessionAdapter['acknowledgeSessionRelease']>
  >
  holdsDispatch: Mock<NonNullable<StructuredAgentSessionAdapter['holdsDispatch']>>
  readOptions: Mock<NonNullable<StructuredAgentSessionAdapter['readOptions']>>
}

export type RestTestRig = {
  root: string
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  adapter: RestTestAdapter
  clock: { now: number }
  statusEvents: AgentSessionStatusEvent[]
  sink: {
    publish: Mock
    forget: Mock
    readChildWork: Mock<(subject: unknown) => AgentChildWorkView[]>
  }
  /** Keep this spawn starting; other children prove startup after publication. */
  heldStart: (
    acquire: StructuredAgentSessionAdapter['acquire']
  ) => StructuredAgentSessionAdapter['acquire']
  proveStart: (child: {
    sessionId: string
    fence: number
    acquisitionGeneration: string
  }) => Promise<void>
  restart: (deps?: Partial<StructuredAgentSessionHostDeps>) => Promise<StructuredAgentSessionHost>
  ownProfile: (root: string) => {
    database: () => ReturnType<typeof openTestJournalHostDatabase>
    openJournal: (options: AgentSessionJournalOptions) => Promise<AgentSessionJournal>
    store: (store: AgentSessionRecordStore) => AgentSessionRecordStore
    host: (host: StructuredAgentSessionHost) => StructuredAgentSessionHost
    closeAdapter: (close: () => Promise<void>) => void
  }
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
  deps: Partial<StructuredAgentSessionHostDeps> = {},
  ownership: {
    scoped?: true
    closeAdapter?: () => Promise<void>
    waitForRecovery?: () => Promise<void>
  } = {}
): Promise<RestTestRig> {
  resetHostTestOperationIds()
  ordinal = 0
  const root = await mkdtemp(join(tmpdir(), 'orca-rest-'))
  const { ownProfile, owned, ownHost, disposeOwned } = createRestTestOwnership(root, ownership)
  try {
    owned?.database()
    const clock = { now: HOST_TEST_NOW }
    const statusEvents: AgentSessionStatusEvent[] = []
    const sink: RestTestRig['sink'] = {
      publish: vi.fn(),
      forget: vi.fn(),
      readChildWork: vi.fn((): AgentChildWorkView[] => [])
    }
    let store = await openTestAgentSessionRecordStore(root)
    owned?.store(store)
    const adapter: RestTestAdapter = {
      open: async () => ({
        reportedOptions: { model: '' }
      }),
      acquire: vi.fn(async ({ fence, spawnToken }) => ({
        acquisitionGeneration: `generation-${++generations}`,
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: codexProviderHandle(THREAD),
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
      holdsDispatch: vi.fn(() => false),
      readOptions: vi.fn(async () => ({ models: [], current: { model: 'gpt-live' } }))
    }
    const starts = structuredAgentSessionHeldStarts(() => rig.host)
    const hostFor = (overrides: Partial<StructuredAgentSessionHostDeps>) =>
      ownHost(
        new StructuredAgentSessionHost({
          agents: claudeAndCodexAgents(),
          logger: createStructuredAgentSessionLogger(),
          store,
          adapter: starts.wrap({
            ...adapter,
            releaseAcquisition: vi.fn(async () => true),
            cancelTurn: async () => ({ cancelled: true }),
            answerPrompt: async ({ commit }) => commit(),
            setOption: async () => undefined
          }),
          journalDatabase: owned?.database() ?? openTestJournalHostDatabase(root),
          claimKeyId: 'key-1',
          mintSpawnToken: () => 'spawn-a',
          probeOwner: async () => ({ outcome: 'pid-absent' }),
          now: () => clock.now,
          statusSink: sink,
          idleSweep: { intervalMs: SWEEP_INTERVAL_MS },
          ...deps,
          ...overrides
        })
      )
    const rig: RestTestRig = {
      root,
      store,
      host: hostFor({}),
      adapter,
      clock,
      statusEvents,
      sink,
      heldStart: starts.held,
      proveStart: starts.prove,
      restart: async (overrides = {}) => {
        await rig.host.flushAllStreamedEvents().catch(() => undefined)
        owned?.database()
        store = await openTestAgentSessionRecordStore(root)
        owned?.store(store)
        rig.store = store
        rig.host = hostFor(overrides)
        rig.host.subscribeStatus({ id: 'status', emit: (event) => statusEvents.push(event) })
        return rig.host
      },
      ownProfile,
      dispose: async () => {
        if (ownership.scoped) {
          return disposeOwned()
        }
        try {
          await rig.host.flushAllStreamedEvents()
        } finally {
          await closeTestJournalHostDatabase(root)
          await rm(root, { recursive: true, force: true })
        }
      }
    }
    rig.host.subscribeStatus({ id: 'status', emit: (event) => statusEvents.push(event) })
    return rig
  } catch (error) {
    if (ownership.scoped) {
      try {
        await disposeOwned()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'REST setup and cleanup failed')
      }
    }
    throw error
  }
}

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

export function sweepOnce(host: StructuredAgentSessionHost): Promise<void> {
  return host.collaboratorsForTests().lifetime.idleSweep.tick()
}

export function sweepTicks(count = 6): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS * count))
}

export { SESSION as REST_TEST_SESSION, THREAD as REST_TEST_THREAD }
