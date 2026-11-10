import { copyCodexConversation } from '../../../../../codex/codex-conversation-copy'
import type * as AppServerSession from '../../../../../codex/app-server/codex-app-server-session'
import { tmpdir } from 'node:os'
import { createRestTestRig } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import { forkTestSource } from '../../../../../native-chat/agent-session-wire/acquisition/testing/structured-agent-session-fork.test-fixture'
import { agentSessionRecordFixture } from '../../../../../native-chat/agent-session-record-test-fixture'
import { codexProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { resolveStructuredAgentSessionForkIntent } from '../../../../../native-chat/agent-session-wire/acquisition/structured-agent-session-fork-intent'
import { structuredAgentSessionCreateParams } from '../../../../../../shared/agent-session/structured-agent-session-create'
import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
// Before attach, classify no-effects refusal; at/after attach, failure cannot prove no session exists.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { recordingStructuredAgentSessionLogger } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../../../../shared/agent-session/failures/agent-session-definitive-refusal'
import { agentSessionRefusalError } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcResponse } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../structured-agent-session'
import './structured-agent-session-create'

const codex = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../../../../codex/app-server/codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AppServerSession>()),
  runCodexAppServerSession: async (
    _launch: unknown,
    body: (rpc: AppServerSession.CodexAppServerRpc) => Promise<unknown>
  ) => body({ request: codex.request, notify: () => {} })
}))

const SESSION = 'session-alpha'
const OPERATION = '1800000000000-00000000000000000000000000000001'
const WORKTREE = 'id:workspace-1'

const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

function createParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: SESSION,
        fields: { worktree: WORKTREE, agent: 'codex' }
      }),
      ...(overrides.envelope as Record<string, unknown> | undefined)
    },
    worktree: WORKTREE,
    agent: 'codex'
  }
}

let attach: ReturnType<typeof vi.fn>

function hostStub(): StructuredAgentSessionHost {
  attach = vi.fn(async () => ({
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-a', sequence: 0 },
    value: { sessionId: SESSION, fence: 1, page: {}, unconfirmedClientMessageIds: [] }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: legacy create reads the empty ledger, calls attach and logs failures.
  return {
    attach,
    deps: {
      logger: recordingStructuredAgentSessionLogger().logger,
      store: { getOperationRow: vi.fn(() => null) }
    }
  } as unknown as StructuredAgentSessionHost
}

const resolvedIntent = {
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  },
  provider: 'codex',
  agent: 'codex',
  accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
  runtimeKind: 'native'
}

async function create(
  runtimeOverrides: Record<string, unknown> = {},
  params: unknown = createParams()
): Promise<RpcResponse> {
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    // Fixtures pass capability admission so they exercise the pre-commit refusal boundary.
    getClientSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix: vi.fn(),
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (input: { envelope: unknown }) => ({
      envelope: input.envelope,
      ...resolvedIntent
    })),
    publishStructuredAgentSessionTab: vi.fn(async () => undefined),
    ...runtimeOverrides
  }
  const replies: RpcResponse[] = []
  await new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  }).dispatchStreaming(
    { id: 'request-1', authToken: 'token', method: 'agentSession.create', params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    STRUCTURED_CLIENT
  )
  const first = replies[0]
  if (!first) {
    throw new Error('no reply for agentSession.create')
  }
  return first
}

/** The refusal a client can act on, or null when the reply was not one. */
function refusalOf(response: RpcResponse): { code: string; message: string } | null {
  if (!response.ok) {
    return null
  }
  const result = response.result as { ok: boolean; refusal?: { code: string; message: string } }
  return result.ok ? null : (result.refusal ?? null)
}

beforeEach(() => {
  setStructuredAgentSessionHost(hostStub())
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
})

describe('a create refused before it commits', () => {
  it('keeps a transcript read exception out of a coded create refusal', async () => {
    const response = await create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async () => {
        throw agentSessionRefusalError(
          'agent_session_identity_required',
          { reason: 'transcriptUnreadable' },
          "ENOENT: no such file or directory, open '/Users/private/rollout-missing.jsonl'"
        )
      })
    })
    expect(refusalOf(response)).toMatchObject({
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' },
      message: 'Orca cannot open a structured agent chat for this workspace.',
      createAttemptRefusedBeforeCommit: true
    })
    expect(attach).not.toHaveBeenCalled()
  })

  it('keeps private precommit faults out of a definitive public refusal', async () => {
    // The class no per-site conversion catches: an unresolvable worktree throws prose, not a code.
    const response = await create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async () => {
        throw new Error('private-workspace-detail-sentinel')
      })
    })

    const refusal = refusalOf(response)
    expect(isDefinitiveAgentSessionCreateRefusal(refusal?.code)).toBe(true)
    expect(JSON.stringify(refusal)).not.toContain('private-workspace-detail-sentinel')
    expect(refusal).not.toHaveProperty('details')
    expect(attach).not.toHaveBeenCalled()
  })
})

async function forkHost() {
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const test = forkTestSource(rig)
  test.snapshot.items[2]!.itemId = 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1'
  const child = agentSessionRecordFixture({
    ...test.record,
    sessionId: 'copied-chat',
    providerHandleChain: [
      {
        ...test.record.providerHandleChain[0]!,
        handle: codexProviderHandle('019e6b26-18e2-7103-b7a0-7ba6bb071124')
      }
    ],
    forkedFrom: {
      sessionId: 'source-chat',
      itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1',
      childBoundary: {
        kind: 'item',
        itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1'
      }
    }
  })
  const childSnapshot = {
    ...structuredClone(test.snapshot),
    sessionId: child.sessionId,
    items: test.snapshot.items.map((item) => ({
      ...item,
      itemId: item.itemId.replace(
        '019e6b26-18e2-7103-b7a0-7ba6bb071123',
        '019e6b26-18e2-7103-b7a0-7ba6bb071124'
      )
    }))
  }
  const records = new Map([
    ['copied-chat', child],
    ['source-chat', test.record]
  ])
  const getRecord = rig.store.getRecord.bind(rig.store)
  const select = rig.store.selectWritableRecord.bind(rig.store)
  const writable = rig.store.requireWritableRecord.bind(rig.store)
  vi.spyOn(rig.store, 'getRecord').mockImplementation((id) => records.get(id) ?? getRecord(id))
  vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation(
    (id) => records.get(id) ?? writable(id)
  )
  vi.spyOn(rig.store, 'selectWritableRecord').mockImplementation((id) =>
    records.has(id) ? { kind: 'writable', record: records.get(id)! } : select(id)
  )
  const snapshot = rig.host.journalSnapshot.bind(rig.host)
  vi.spyOn(rig.host, 'journalSnapshot').mockImplementation((id) =>
    id === 'copied-chat'
      ? Promise.resolve(childSnapshot)
      : id === 'source-chat'
        ? Promise.resolve(test.snapshot)
        : snapshot(id)
  )
  const capabilities = rig.host.deps.agents.capabilities.bind(rig.host.deps.agents)
  vi.spyOn(rig.host.deps.agents, 'capabilities').mockImplementation((agent) => {
    const supported = capabilities(agent)
    return supported ? { ...supported, fork: 'checkpoint' } : null
  })
  rig.host.deps.adapter.copyConversation = test.copy
  setStructuredAgentSessionHost(rig.host)
  const createFork = (sessionId: string) =>
    create(
      {
        resolveStructuredAgentSessionCreateIntent: async (
          input: Parameters<OrcaRuntimeService['resolveStructuredAgentSessionCreateIntent']>[0]
        ) => {
          if (!input.forkFrom) {
            throw new Error('Expected a fork intent')
          }
          return resolveStructuredAgentSessionForkIntent({
            ...input,
            forkFrom: input.forkFrom,
            host: rig.host,
            location: test.record.location
          })
        }
      },
      structuredAgentSessionCreateParams({
        sessionId,
        worktree: WORKTREE,
        agent: 'codex',
        forkFrom: {
          sessionId: 'copied-chat',
          throughItemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1'
        },
        randomUuid: () => '00000000-0000-0000-0000-000000000001',
        now: 1800000000000
      })
    )
  return { rig, test, records, createFork }
}

it('preserves source-admission proof through real fork create without publishing a destination', async () => {
  const { rig, test, records, createFork } = await forkHost()
  try {
    records.delete('source-chat')
    expect(refusalOf(await createFork('codex_missing_original'))).toMatchObject({
      code: 'agent_session_identity_required',
      details: { reason: 'recordMissing' },
      createAttemptRefusedBeforeCommit: true
    })
    expect(rig.store.getRecord('codex_missing_original')).toBeNull()
    records.set('source-chat', test.record)
    test.snapshot.items = test.snapshot.items.slice(0, 1)
    expect(refusalOf(await createFork('codex_removed_original_reply'))).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' },
      createAttemptRefusedBeforeCommit: true
    })
    expect(rig.store.getRecord('codex_removed_original_reply')).toBeNull()
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})

it('does not prove no copy when source revalidation fails after the native copy', async () => {
  const { rig, test, createFork } = await forkHost()
  try {
    const nativeCopy = test.copy.getMockImplementation()!
    test.copy.mockImplementationOnce(async (input) => {
      const copy = await nativeCopy(input)
      test.snapshot.items = test.snapshot.items.slice(0, 1)
      return copy
    })
    const refusal = refusalOf(await createFork('codex_changed_after_copy'))
    expect(refusal).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'savedConversationMissing' }
    })
    expect(refusal).not.toHaveProperty('createAttemptRefusedBeforeCommit')
    expect(rig.store.getRecord('codex_changed_after_copy')).toBeNull()
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})

it('settles a redirected Codex preparation refusal but not a dispatched child-read failure', async () => {
  const { rig, test, createFork } = await forkHost()
  test.record.conversationName = '  Release notes  '
  try {
    test.copy.mockImplementation((input) =>
      copyCodexConversation(input, {
        resolveLaunchArgs: () => [],
        resolveWorkspacePath: async () => tmpdir(),
        resolveCommand: () => ({ command: 'codex', prefixArgs: [] })
      })
    )
    codex.request.mockRejectedValue(new Error('source read failed'))
    expect(refusalOf(await createFork('codex_source_read_failed'))).toMatchObject({
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' },
      createAttemptRefusedBeforeCommit: true
    })
    expect(rig.store.getRecord('codex_source_read_failed')).toBeNull()
    codex.request.mockImplementation(async (method: string) => {
      if (method === 'thread/read') {
        return { thread: { id: '019e6b26-18e2-7103-b7a0-7ba6bb071123', historyMode: 'paginated' } }
      }
      if (method === 'thread/fork') {
        return { thread: { id: '01a1bde0-5ded-7f03-a1bf-3dae1613d8c7' } }
      }
      throw new Error('child read failed')
    })
    // Source listing succeeds before the child read fails.
    codex.request
      .mockImplementationOnce(async () => ({
        thread: { id: '019e6b26-18e2-7103-b7a0-7ba6bb071123', historyMode: 'paginated' }
      }))
      .mockImplementationOnce(async () => ({
        data: [{ id: 'completed-turn', status: 'completed' }],
        nextCursor: null
      }))
    const refusal = refusalOf(await createFork('codex_child_read_failed'))
    expect(refusal).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'providerRejected' }
    })
    expect(refusal).not.toHaveProperty('createAttemptRefusedBeforeCommit')
    expect(rig.store.getRecord('codex_child_read_failed')).toBeNull()
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})
