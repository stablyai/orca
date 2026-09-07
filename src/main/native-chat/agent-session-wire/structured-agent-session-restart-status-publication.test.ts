// Startup restore has to publish status, not just index the session.
//
// A tab nobody reopens after a restart still owes the sidebar a row. The host restores such a
// session read-only, without a provider child, so the only thing that can surface its state is
// the status publication the restore wiring makes.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionStatusEvent
} from '../../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
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

const CALLER = { callerKey: 'client-1' }

const hosts: StructuredAgentSessionHost[] = []
let root = ''
let providerEvents: StructuredAgentSessionEventSink | undefined

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire: async ({ fence, spawnToken, events }) => {
      providerEvents = events
      return {
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: THREAD },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    },
    dispatch: async () => ({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
    }),
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
    probeOwner: async () => ({
      outcome: 'indeterminate',
      reason: 'read does not need ownership'
    }),
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
async function restartWithPersistedTurn(running = false): Promise<StructuredAgentSessionHost> {
  root = await mkdtemp(join(tmpdir(), 'orca-restart-status-'))
  providerEvents = undefined
  resetHostTestOperationIds()
  const directory = join(root, 'store')
  const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  const host = createHost(store)
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const body = hostTestMessage('persisted conversation')
  await host.send(CALLER, { envelope: sendEnvelope(store, { body }), body })
  if (running) {
    const events = providerEvents as StructuredAgentSessionEventSink | undefined
    if (!events) {
      throw new Error('provider event sink was not acquired')
    }
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 },
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { lifecycle: true }
    )
  }
  await host.flushAllStreamedEvents()
  return createHost(await AgentSessionRecordStore.open({ directory, hostId: 'local' }))
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.flushAllStreamedEvents()))
  await rm(root, { recursive: true, force: true })
  root = ''
})

describe('structured session restart status publication', () => {
  // Served by the subscribe-time re-projection rather than the restore's own publish, so this
  // covers what a restored journal projects — not the restore wiring. The test below pins that.
  it('projects a boot-restored running turn as idle without a provider child', async () => {
    const restarted = await restartWithPersistedTurn(true)

    await restarted.restoreReadableSessions()
    const history = restarted.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok && history.page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            turnLifecycle: { turnId: 'turn-1', state: 'running' }
          })
        })
      ])
    )
    const events: AgentSessionStatusEvent[] = []
    restarted.subscribeStatus({ id: 'session-list', emit: (event) => events.push(event) })

    expect(events).toEqual([
      {
        type: 'snapshot',
        sessions: [
          expect.objectContaining({
            sessionId: SESSION,
            workspaceId: 'workspace-1',
            agent: 'codex',
            status: 'idle',
            latestPrompt: 'persisted conversation'
          })
        ]
      }
    ])
  })

  it('publishes a restored session to a list already sitting on the stream', async () => {
    const restarted = await restartWithPersistedTurn()
    const events: AgentSessionStatusEvent[] = []
    restarted.subscribeStatus({ id: 'session-list', emit: (event) => events.push(event) })
    expect(events).toEqual([{ type: 'snapshot', sessions: [] }])

    await restarted.restoreReadableSessions()

    // The restore wiring publishes; without it this list never hears about the session at all.
    expect(events.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ sessionId: SESSION, status: 'idle' })
    })
  })
})
