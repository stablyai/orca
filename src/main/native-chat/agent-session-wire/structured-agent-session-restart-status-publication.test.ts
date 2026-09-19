import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-ownership'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import {
  legacyAgentJournalTurnStatusBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
// Startup restore has to publish status, not just index the session.
//
// A tab nobody reopens after a restart still owes the sidebar a row. The host restores such a
// session read-only, without a provider child, so the only thing that can surface its state is
// the status publication the restore wiring makes.

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type {
  AgentSessionSubscribeEvent,
  AgentSessionStatusSummary,
  AgentSessionMutationEnvelope,
  AgentSessionStatusEvent
} from '../../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

import { createStructuredAgentSessionOwnerProbe } from '../../runtime/structured-agent-session-owner-probe'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'

let probe: AgentSessionOwnerProbe | 'production' = {
  outcome: 'indeterminate',
  reason: 'controlled unavailable probe'
}
let testProvider: 'codex' | 'claude' = 'codex'
let legacyTurn = false
const CALLER = { callerKey: 'client-1' }

const hosts: StructuredAgentSessionHost[] = []
let root = ''

function adapter(): StructuredAgentSessionAdapter {
  return new StructuredAgentSessionAdapterRouter(
    { codex: providerAdapter('codex'), claude: providerAdapter('claude') },
    async () => {}
  )
}

function providerAdapter(provider: 'codex' | 'claude'): StructuredAgentSessionAdapter {
  let sink: StructuredAgentSessionEventSink | undefined
  return {
    supportsLocation: () => true,
    closeSession: async () => true,
    readOptions: async () => ({ models: [], current: { model: 'fixture' } }),
    releaseAcquisition: async () => true,
    acquire: async ({ fence, spawnToken, events }) => {
      sink = events
      return {
        process: {
          hostId: 'local',
          pid: 2147483647,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        link: {
          linkId: `link-${fence}`,
          handle:
            provider === 'codex'
              ? { provider, threadId: THREAD }
              : { provider, sessionId: THREAD, leafUuid: null },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    },
    dispatch: async () => {
      const turn = { turnId: 'turn-1', state: 'running', startedAt: NOW } as const
      const identity =
        provider === 'codex'
          ? { provider, threadId: THREAD, turnId: 'turn-1', ordinal: 2 }
          : { provider, sessionId: THREAD, uuid: 'turn-1' }
      sink?.appendItem(
        identity,
        legacyTurn ? legacyAgentJournalTurnStatusBody(turn, 'turn-1') : { kind: 'turn', ...turn },
        { lifecycle: true }
      )
      sink?.publish()
      return {
        state: 'accepted',
        providerIdentity:
          provider === 'codex'
            ? { provider, threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
            : { provider, sessionId: THREAD, uuid: 'message-1' }
      }
    },
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async () => undefined,
    setOption: async () => undefined
  }
}

function createHost(store: AgentSessionRecordStore): StructuredAgentSessionHost {
  const host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    probeOwner: async (record) =>
      probe === 'production' ? createStructuredAgentSessionOwnerProbe('local')(record) : probe,
    now: () => NOW
  })
  hosts.push(host)
  return host
}

function sendEnvelope(
  store: AgentSessionRecordStore,
  fields: Record<string, unknown>
): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields
    })
  }
}

/** Persists one turn, then hands back a restarted host over the same directories. */
async function restartWithPersistedTurn(): Promise<StructuredAgentSessionHost> {
  root = await mkdtemp(join(tmpdir(), 'orca-restart-status-'))
  resetHostTestOperationIds()
  const directory = join(root, 'store')
  const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  const host = createHost(store)
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(
        null,
        testProvider === 'claude'
          ? {
              provider: 'claude',
              agent: 'claude',
              accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/fixture/claude' },
              providerHandle: { kind: 'claude', sessionId: THREAD, leafUuid: null }
            }
          : {}
      )
    )
  ).toMatchObject({ ok: true })
  const body = hostTestMessage('persisted conversation')
  await host.send(CALLER, { envelope: sendEnvelope(store, { body }), body })
  await host.flushAllStreamedEvents()
  return createHost(await AgentSessionRecordStore.open({ directory, hostId: 'local' }))
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.flushAllStreamedEvents()))
  await rm(root, { recursive: true, force: true })
  root = ''
})

async function crashImage(
  statusSink?: StructuredAgentSessionStatusSink
): Promise<StructuredAgentSessionHost> {
  root = await mkdtemp(join(tmpdir(), 'orca-crash-status-'))
  resetHostTestOperationIds()
  const original = join(root, 'original')
  const saved = join(root, 'crashed')
  const store = await AgentSessionRecordStore.open({
    directory: join(original, 'store'),
    hostId: 'local'
  })
  const host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: original,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  hosts.push(host)
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(
        null,
        testProvider === 'claude'
          ? {
              provider: 'claude',
              agent: 'claude',
              accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/fixture/claude' },
              providerHandle: { kind: 'claude', sessionId: THREAD, leafUuid: null }
            }
          : {}
      )
    )
  ).toMatchObject({ ok: true })
  const body = hostTestMessage('persisted conversation')
  expect(await host.send(CALLER, { envelope: sendEnvelope(store, { body }), body })).toMatchObject({
    ok: true
  })
  await host.flushStreamedEvents(SESSION)
  expect(
    host
      .journalSnapshot(SESSION)
      .items.some((item) => readAgentJournalTurn(item.body)?.state === 'running')
  ).toBe(true)
  // Copy the quiescent durable image BEFORE cleanup; teardown only touches the original.
  await cp(original, saved, { recursive: true })
  await host.flushAllStreamedEvents()
  hosts.pop()
  const restoredStore = await AgentSessionRecordStore.open({
    directory: join(saved, 'store'),
    hostId: 'local'
  })
  const restarted = new StructuredAgentSessionHost({
    store: restoredStore,
    statusSink,
    adapter: adapter(),
    journalRoot: saved,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-b',
    now: () => NOW,
    probeOwner: async (record) =>
      probe === 'production' ? createStructuredAgentSessionOwnerProbe('local')(record) : probe
  })
  hosts.push(restarted)
  return restarted
}

function summaries(events: AgentSessionStatusEvent[]) {
  return events.flatMap((event) =>
    event.type === 'status' ? [event.session] : event.type === 'snapshot' ? event.sessions : []
  )
}

for (const provider of ['codex', 'claude'] as const) {
  for (const legacy of [false, true]) {
    for (const scenario of ['production', 'pid-absent', 'indeterminate'] as const) {
      it(`crash image: ${provider}, legacy=${legacy}, ${scenario}, existing and arriving observers`, async () => {
        testProvider = provider
        legacyTurn = legacy
        probe =
          scenario === 'production'
            ? scenario
            : scenario === 'pid-absent'
              ? { outcome: 'pid-absent' }
              : { outcome: 'indeterminate', reason: 'controlled unavailable probe' }
        const restarted = await crashImage()
        const before: AgentSessionStatusEvent[] = []
        restarted.subscribeStatus({ id: 'before', emit: (event) => before.push(event) })
        await restarted.restoreReadableSessions()
        await restarted.restoreReadableSessions()
        const atRestore = summaries(before).map((s) => s.status)
        const snapshot = restarted.journalSnapshot(SESSION)
        const lifecycle = snapshot.items.flatMap((item) => {
          const turn = readAgentJournalTurn(item.body)
          return turn ? [turn] : []
        })
        const after: AgentSessionStatusEvent[] = []
        restarted.subscribeStatus({ id: 'after', emit: (event) => after.push(event) })
        expect(atRestore).not.toContain('working')
        expect(summaries(after).at(-1)?.execution?.observation).toBe(
          scenario === 'indeterminate' ? 'unverifiable' : 'exited'
        )
        expect(lifecycle).toEqual([
          expect.objectContaining({
            state: scenario === 'indeterminate' ? 'running' : 'unverifiable'
          })
        ])
        expect(summaries(before).at(-1)?.status).toBe(summaries(after).at(-1)?.status)
        expect(atRestore.at(-1)).not.toBe('working')
      })
    }
  }
}

it('graceful shutdown remains idle', async () => {
  testProvider = 'codex'
  legacyTurn = false
  probe = { outcome: 'indeterminate', reason: 'controlled unavailable probe' }
  const restarted = await restartWithPersistedTurn()
  await restarted.restoreReadableSessions()
  const events: AgentSessionStatusEvent[] = []
  restarted.subscribeStatus({ id: 'list', emit: (event) => events.push(event) })
  expect(summaries(events).at(-1)?.status).toBe('idle')
})

it('publishes settlement to the canonical sink and a transcript attached before repair', async () => {
  probe = { outcome: 'pid-absent' }
  const canonical: AgentSessionStatusSummary[] = []
  const transcript: AgentSessionSubscribeEvent[] = []
  let subscribed = false
  const restarted = await crashImage({
    forget: () => {},
    publish: (summary) => {
      canonical.push(summary)
      if (!subscribed) {
        subscribed = true
        restarted.subscribe({
          id: 'early-transcript',
          sessionId: SESSION,
          emit: (event) => transcript.push(event)
        })
      }
    }
  })
  await restarted.restoreReadableSessions()
  expect(canonical.map((summary) => summary.status)).not.toContain('working')
  expect(canonical.at(-1)?.status).toBe('idle')
  const repaired = transcript.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
  expect(repaired.some((item) => readAgentJournalTurn(item.body)?.state === 'unverifiable')).toBe(
    true
  )
})
