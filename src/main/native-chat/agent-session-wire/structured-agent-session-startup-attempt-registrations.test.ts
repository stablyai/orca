// Every agent this build registers starts under the host's one startup attempt and its hold on
// delivery. Iterates the runtime's real registration list, so an agent registered later is covered
// without being named here.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from '../../runtime/structured-agent-runtime-registrations'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import { StructuredAgentRegistry } from './structured-agent-registry'
import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const CALLER = { callerKey: 'client-1' }

// Temporary, removed when every adapter publishes at spawn: adapters whose own acquire already does,
// with the test that drives the real one. Every other registration still runs its handshake inside
// acquire (the bridge) until then.
const REAL_ADAPTER_PUBLISHES_AT_SPAWN: Readonly<Record<string, string>> = {
  claude: 'structured-agent-session-claude-hung-start-stop.test.ts'
}

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

function accountHome(definition: StructuredAgentDefinition): AgentSessionAccountHome {
  return definition.accountLocatorKind === 'opencode'
    ? { kind: 'opencode', locator: { kind: 'unmanaged' } }
    : { variable: definition.accountHomeVariable, path: `/home/dev/.${definition.agent}` }
}

function handle(definition: StructuredAgentDefinition): AgentSessionProviderHandle {
  return { transport: definition.handleTransport, agent: definition.agent, nativeId: 'native-1' }
}

/** A host driving `definition` over a scripted adapter that publishes its child at spawn. */
async function hostFor(definition: StructuredAgentDefinition): Promise<{
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
  acquire: Mock<StructuredAgentSessionAdapter['acquire']>
  dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
}> {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-registrations-'))
  resetHostTestOperationIds()
  const store = await openTestAgentSessionRecordStore(root)
  const acquire: Mock<StructuredAgentSessionAdapter['acquire']> = vi.fn(
    async (input: StructuredAgentSessionAcquireInput) => ({
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: 1_700_000_000_000,
        spawnToken: input.spawnToken
      },
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      providerChildPhase: 'starting' as const,
      link: {
        linkId: `link-${input.fence}`,
        handle: handle(definition),
        origin: 'created' as const,
        mintedAtFence: input.fence,
        observedAt: NOW
      }
    })
  )
  const dispatch: Mock<StructuredAgentSessionAdapter['dispatch']> = vi.fn(async () => ({
    state: 'admitted' as const
  }))
  const adapter: StructuredAgentSessionAdapter = {
    acquire,
    dispatch,
    closeSession: vi.fn(async () => true),
    releaseAcquisition: vi.fn(async () => true),
    cancelTurn: vi.fn(async () => ({ cancelled: false })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined)
  }
  const declared: StructuredAgentDefinition = {
    ...definition,
    // The double implements none of the optional capabilities' methods.
    capabilities: { ...definition.capabilities, rewind: false, compact: false, threadGoal: false }
  }
  const host = new StructuredAgentSessionHost({
    agents: new StructuredAgentRegistry([{ definition: declared, adapter }]),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    now: () => NOW
  })
  return { host, store, acquire, dispatch }
}

describe.each(
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
    ({ definition }) => [definition.agent, definition] as const
  )
)('%s starts under the host attempt', (agent, definition) => {
  it('acquires under a host-minted attempt and is handed nothing until it proves its start', async () => {
    const { host, store, acquire, dispatch } = await hostFor(definition)
    try {
      const attached = await host.attach(
        CALLER,
        hostTestAttachParams(null, {
          provider: agent,
          agent,
          accountHome: accountHome(definition),
          // A new chat: the provider mints its handle at acquire.
          providerHandle: undefined
        })
      )
      expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
      const record = store.getRecord(SESSION)!
      expect(acquire.mock.calls[0]?.[0]).toMatchObject({
        attemptId: expect.any(String),
        fence: record.lease.runtimeFence,
        launch: { location: record.location, accountHome: record.accountHome },
        onOutput: expect.any(Function)
      })

      const body = hostTestMessage('hello')
      const sent = await host.send(CALLER, {
        envelope: {
          sessionId: SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: record.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      })
      expect(sent).toMatchObject({ ok: true })
      await vi.waitFor(() =>
        expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(
          false
        )
      )
      expect(dispatch).not.toHaveBeenCalled()

      await host.handleAdapterEvent({
        type: 'started',
        sessionId: SESSION,
        fence: record.lease.runtimeFence,
        acquisitionGeneration: 'generation-1',
        reportedOptions: { model: 'default' },
        restoreSkippedOptions: [],
        optionRevision: host.collaboratorsForTests().runtimeState.optionRevisions.current(SESSION)
      })

      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    } finally {
      await host.flushAllStreamedEvents()
    }
  })
})

describe.each(
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(({ definition }) => definition.agent).filter(
    (agent) => !REAL_ADAPTER_PUBLISHES_AT_SPAWN[agent]
  )
)('%s with its own adapter', () => {
  it.todo('publishes at spawn instead of finishing its handshake first')
})
