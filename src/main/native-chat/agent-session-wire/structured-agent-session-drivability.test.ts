// A record this build cannot drive (its agent's definition now names another transport or account
// variable, or the record pins another agent's variable) stays readable; only starting its agent is
// refused, at the one launch admission every agent passes through.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import { StructuredAgentSessionHost } from './structured-agent-session-host'

const NOW = 1_800_000_000_000
const SESSION = 'grok-session'
const GROK_HOME: AgentSessionAccountHome = { variable: 'GROK_HOME', path: '/home/dev/.grok' }
let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

const GROK: StructuredAgentDefinition = {
  ...CODEX_STRUCTURED_AGENT,
  agent: 'grok',
  handleTransport: 'acp',
  accountHomeVariable: 'GROK_HOME',
  capabilities: {
    ...CODEX_STRUCTURED_AGENT.capabilities,
    rewind: false,
    compact: false,
    threadGoal: false
  },
  restingOptions: {
    acceptsKey: () => false,
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only the methods a declaration needs; this one declares none of them.
const NO_METHODS = {} as StructuredAgentSessionAdapter
const grokRegistered = (definition: StructuredAgentDefinition = GROK) =>
  new StructuredAgentRegistry([{ definition, adapter: NO_METHODS }])

function params(
  operation: string,
  expectedRuntimeFence: number | null,
  accountHome = GROK_HOME
): AgentSessionAttachParams {
  const attach: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: `${NOW}-${operation.padStart(32, '0')}`,
      expectedRuntimeFence,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'grok',
    agent: 'grok',
    accountHome,
    runtimeKind: 'native'
  }
  return {
    ...attach,
    envelope: {
      ...attach.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(attach)
      })
    }
  }
}

function grokAdapter(): StructuredAgentSessionAdapter {
  return {
    supportsLocation: () => true,
    acquire: vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementation(async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: `grok-link-${fence}`,
          handle: { transport: 'acp', agent: 'grok', nativeId: 'grok-native-1' },
          origin: fence === 1 ? 'created' : 'resumed',
          mintedAtFence: fence,
          observedAt: NOW
        }
      })),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

async function attach(input: {
  agents: StructuredAgentRegistry
  adapter: StructuredAgentSessionAdapter
  params: AgentSessionAttachParams
  spawnToken: string
  store?: AgentSessionRecordStore
}) {
  const store = input.store ?? (await openTestAgentSessionRecordStore(root!))
  const result = await performAttach({
    agents: input.agents,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: input.adapter,
    openConversation: async (record) => {
      const journal = await openTestAttachConversation(openTestJournalHostDatabase(root!))(record)
      return journal
    },
    authority: {
      spawnToken: input.spawnToken,
      claimKeyId: 'key-1',
      handoffOperationId: input.params.envelope.clientOperationId,
      probe: { outcome: 'reservation-unused' }
    },
    callerKey: 'client-1',
    optionRevision: () => 0,
    params: input.params,
    now: () => NOW,
    onAttached: async (attached) => {
      await attached.journal.close()
    }
  })
  return { result, store }
}

/** Persist and reopen a Grok chat whose original child is gone. */
async function createdGrokChat() {
  root = await mkdtemp(join(tmpdir(), 'orca-drivability-'))
  const created = await attach({
    agents: grokRegistered(),
    adapter: grokAdapter(),
    params: params('1', null),
    spawnToken: 'spawn-a'
  })
  expect(created.result).toMatchObject({ ok: true })
  const store = await openTestAgentSessionRecordStore(root)
  await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: NOW + 1 })
  return { store, fence: store.getRecord(SESSION)!.lease.runtimeFence }
}

const UNSUPPORTED = {
  ok: false,
  refusal: { code: 'structured_agent_session_unsupported', details: { reason: 'hostUnsupported' } }
}

it('refuses an unregistered agent before creating a durable record', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-drivability-'))
  const adapter = grokAdapter()
  const { result, store } = await attach({
    agents: new StructuredAgentRegistry([]),
    adapter,
    params: params('1', null),
    spawnToken: 'spawn-unregistered'
  })
  expect(result).toMatchObject(UNSUPPORTED)
  expect(adapter.acquire).not.toHaveBeenCalled()
  expect(store.getRecord(SESSION)).toBeNull()
})

it('keeps saved history readable without a registration and resumes when it returns', async () => {
  const created = await createdGrokChat()
  await created.store.setSessionTabVisibility(SESSION, true)
  const journal = await openTestAttachConversation(openTestJournalHostDatabase(root!))(
    created.store.getRecord(SESSION)!
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'saved-reply' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Saved reply' }] },
    { fence: created.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.close()

  const store = await openTestAgentSessionRecordStore(root!)
  const agents = new StructuredAgentRegistry([])
  const router = new StructuredAgentSessionAdapterRouter(agents, async () => {})
  const acquire = vi.spyOn(router, 'acquire')
  const host = new StructuredAgentSessionHost({
    store,
    agents,
    adapter: router,
    journalDatabase: openTestJournalHostDatabase(root!),
    claimKeyId: 'key-1',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    logger: createStructuredAgentSessionLogger(),
    now: () => NOW + 2
  })
  try {
    expect(router.supportsCreate(params('2', created.fence).location, 'grok')).toBe(false)
    expect(store.listVisibleSessionIds()).toEqual([SESSION])
    await host.restoreReadableSessions([SESSION])
    expect(host.hasSession(SESSION)).toBe(true)
    await expect(host.revealSession(SESSION)).resolves.toMatchObject({
      sessionId: SESSION,
      agent: 'grok',
      readable: true
    })
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history).toMatchObject({
      ok: true,
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Saved reply' }]
            }
          })
        ])
      }
    })
    const before = store.getRecord(SESSION)!.lease.runtimeFence
    await expect(
      host.attach({ callerKey: 'client-1' }, params('2', before))
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(acquire).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)!.lease.runtimeFence).toBe(before)
  } finally {
    await host.flushAllStreamedEvents()
  }

  const adapter = grokAdapter()
  const { result } = await attach({
    agents: grokRegistered(),
    adapter,
    params: params('3', store.getRecord(SESSION)!.lease.runtimeFence),
    spawnToken: 'spawn-restored',
    store
  })
  expect(result).toMatchObject({ ok: true })
  expect(adapter.acquire).toHaveBeenCalledOnce()
  expect(store.listVisibleSessionIds()).toEqual([SESSION])
})

it.each([
  ['its transport', { ...GROK, handleTransport: 'grok-native' }],
  ['its account variable', { ...GROK, accountHomeVariable: 'GROK_CONFIG_DIR' }]
])(
  'keeps a chat readable after its agent changes %s, and refuses to start it',
  async (_change, changed) => {
    const { store, fence } = await createdGrokChat()
    const adapter = grokAdapter()

    const { result } = await attach({
      agents: grokRegistered(changed),
      adapter,
      params: params('2', fence),
      spawnToken: 'spawn-b',
      store
    })

    expect(result).toMatchObject(UNSUPPORTED)
    expect(adapter.acquire).not.toHaveBeenCalled()
    // Still listed and readable: its tab publishes and its history opens.
    expect(store.getRecord(SESSION)).toMatchObject({ provider: 'grok', accountHome: GROK_HOME })
    expect(store.getRecord(SESSION)?.providerHandleChain[0]?.handle.transport).toBe('acp')
  }
)

it("refuses to start a chat that pins another agent's account variable", async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-drivability-'))
  const adapter = grokAdapter()

  const { result } = await attach({
    agents: grokRegistered(),
    adapter,
    params: params('1', null, { variable: 'CODEX_HOME', path: '/home/dev/.codex' }),
    spawnToken: 'spawn-a'
  })

  expect(result).toMatchObject(UNSUPPORTED)
  expect(adapter.acquire).not.toHaveBeenCalled()
})

it('starts the same chat again once its agent is declared as it was', async () => {
  const { store, fence } = await createdGrokChat()
  const adapter = grokAdapter()

  const { result } = await attach({
    agents: grokRegistered(),
    adapter,
    params: params('2', fence),
    spawnToken: 'spawn-b',
    store
  })

  expect(result).toMatchObject({ ok: true })
  expect(adapter.acquire).toHaveBeenCalledOnce()
})

it('refuses an attach whose agent is not the session it names', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-drivability-'))
  const adapter = grokAdapter()
  const mismatched = { ...params('1', null), agent: 'codex' }

  const { result, store } = await attach({
    agents: grokRegistered(),
    adapter,
    params: {
      ...mismatched,
      envelope: {
        ...mismatched.envelope,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.attach',
          sessionId: SESSION,
          fields: attachFingerprintFields(mismatched)
        })
      }
    },
    spawnToken: 'spawn-a'
  })

  expect(result).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_invalid', details: { reason: 'requestMalformed' } }
  })
  expect(adapter.acquire).not.toHaveBeenCalled()
  expect(store.getRecord(SESSION)).toBeNull()
})
