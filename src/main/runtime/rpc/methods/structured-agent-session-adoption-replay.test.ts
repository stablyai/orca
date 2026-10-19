import type { AgentProcessVerdict } from '../../../../shared/agent-process-presence'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import '../unused-default-rpc-methods.test-fixture'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { claudeAndCodexAgents } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'

const SESSION = 'session-adoption-replay'
const THREAD = 'thread-adoption-replay'
const WORKSPACE = 'workspace-1'
const SOURCE_LEAF = '11111111-1111-4111-8111-111111111111'
const SOURCE_PANE = `tab-source:${SOURCE_LEAF}`
const OPERATION = `${Date.now()}-00000000000000000000000000000001`
const CLIENT = {
  clientId: 'device-a',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

let root: string
let host: StructuredAgentSessionHost

// The source terminal is a shell with nothing left running in it.
vi.mock('../../../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFreshShellForegroundSnapshot: async () => [
    { pid: 10, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }
  ]
}))

function adapter(): StructuredAgentSessionAdapter {
  return {
    supportsCreate: () => true,
    acquire: vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementation(async ({ fence, spawnToken }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_800_000_000_000,
          spawnToken
        },
        link: {
          linkId: `codex-${fence}-${THREAD}`,
          handle: codexProviderHandle(THREAD),
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: 1_800_000_000_000
        }
      })),
    releaseAcquisition: vi.fn(async () => true),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

function createParams(operationId = OPERATION, sessionId = SESSION) {
  const fields = {
    worktree: `id:${WORKSPACE}`,
    agent: 'codex' as const,
    resumeFrom: {
      providerSessionId: THREAD,
      cliSource: { workspaceId: WORKSPACE, paneKey: SOURCE_PANE }
    }
  }
  return {
    envelope: {
      sessionId,
      clientOperationId: operationId,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields
      })
    },
    ...fields
  }
}

async function call(
  dispatcher: RpcDispatcher,
  params: unknown,
  client: RpcDispatchStreamingOptions = CLIENT,
  unary = false
) {
  const replies: RpcResponse[] = []
  const request: RpcRequest = {
    id: `request-${replies.length + 1}`,
    authToken: 'token',
    method: 'agentSession.create',
    params
  }
  if (unary) {
    return dispatcher.dispatch(request, client)
  }
  await dispatcher.dispatchStreaming(
    request,
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  return replies[0]
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-adoption-rpc-replay-'))
  // Why: the adopting create pre-trusts its folder in ~/.codex and Orca's managed Codex home.
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('USERPROFILE', join(root, 'home'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await host?.flushAllStreamedEvents()
  await host?.close(SESSION, 'evict')
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('committed adopting create RPC replay', () => {
  it.each([true, false])('captures source before routing (unary=%s)', async (unary) => {
    const originalHome = join(root, 'account-original')
    const driftedHome = join(root, 'account-drifted')
    const transcriptPath = join(
      originalHome,
      'sessions',
      '2026',
      '09',
      '06',
      `rollout-2026-09-06T18-00-00-${THREAD}.jsonl`
    )
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: THREAD, timestamp: '2026-09-06T18:00:00.000Z', cwd: '/workspace' }
      })}\n${JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-06T18:00:01.000Z',
        payload: { type: 'message', role: 'user', content: 'durable adopted history' }
      })}\n`,
      'utf8'
    )

    let selectedHome = originalHome
    const selectAccountHome = vi.fn(() => selectedHome)
    let writerVerdict: AgentProcessVerdict = 'live'
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: {} }
        })
      } as never,
      undefined,
      {
        prepareCodexStructuredLaunch: selectAccountHome,
        readHookCliWriterObservation: () => ({
          current: () => true,
          topology: 'pane-owned',
          presence: async () => writerVerdict
        })
      }
    )
    const sourceRow = {
      paneKey: SOURCE_PANE,
      worktreeId: WORKSPACE,
      agentType: 'codex',
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1,
      state: 'waiting' as const,
      prompt: '',
      providerSession: { key: 'session_id' as const, id: THREAD, transcriptPath }
    }
    let rows: AgentStatusIpcPayload[] = [sourceRow]
    runtime.registerPty('source-pty', WORKSPACE, null, {
      tabId: 'tab-source',
      leafId: SOURCE_LEAF,
      incarnationId: 'i1'
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the source census reads only listProcesses.
    runtime.setPtyController({
      listProcesses: async () => [{ id: 'source-pty', rootProcessId: 10, incarnationId: 'i1' }]
    } as never)
    const sourceRows = vi
      .spyOn(runtime, 'getAgentProviderSessionRows')
      .mockImplementation(() => rows)
    // The structured surface is settings-gated for every caller, not just mobile; this test
    // probes durable-identity replay, which only runs once the gate admits the call.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The RPC gate reads only this setting from the test double.
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      experimentalNativeChat: true
    } as ReturnType<OrcaRuntimeService['getClientSettings']>)
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: () => Promise<{
        executionHostId: 'local'
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: () => Promise<{ worktree: { path: string } }>
      ensureStructuredAgentSessionHost: () => Promise<void>
      publishStructuredAgentSessionTab: () => Promise<void>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))
    internal.ensureStructuredAgentSessionHost = vi.fn(async () => undefined)
    internal.publishStructuredAgentSessionTab = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('simulated lost tab publication'))
      .mockResolvedValue(undefined)

    const store = await openTestAgentSessionRecordStore(root)
    const sessionAdapter = adapter()
    host = new StructuredAgentSessionHost({
      agents: claudeAndCodexAgents(sessionAdapter),
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: sessionAdapter,
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1'
    })
    setStructuredAgentSessionHost(host)
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: STRUCTURED_AGENT_SESSION_METHODS
    })
    const historyFields = {
      worktree: `id:${WORKSPACE}`,
      agent: 'codex' as const,
      resumeFrom: { providerSessionId: THREAD }
    }
    const historyParams = {
      ...historyFields,
      envelope: {
        ...createParams().envelope,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: historyFields
        })
      }
    }
    for (const capabilities of [
      CLIENT.clientCapabilities,
      [...CLIENT.clientCapabilities, AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY]
    ]) {
      expect(
        await call(
          dispatcher,
          historyParams,
          { ...CLIENT, clientCapabilities: capabilities },
          unary
        )
      ).toMatchObject({
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_conflict',
            details: { reason: 'conversationHeldElsewhere' },
            createAttemptRefusedBeforeCommit: true
          }
        }
      })
      expect(store.getRecord(SESSION)).toBeFalsy()
      expect(sessionAdapter.acquire).not.toHaveBeenCalled()
    }
    writerVerdict = 'exited'
    const params = createParams()

    rows = unary
      ? []
      : [{ ...sourceRow, providerSession: { ...sourceRow.providerSession, id: 'replaced' } }]
    const route = vi
      .spyOn(runtime, 'routeClientHostedBrowserRpc')
      .mockImplementationOnce(async () => {
        rows = [sourceRow]
        return { handled: false }
      })
    expect(await call(dispatcher, params, CLIENT, unary)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { details: { reason: 'transcriptUnreadable' } } }
    })
    expect(sessionAdapter.acquire).not.toHaveBeenCalled()
    expect(internal.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
    selectAccountHome.mockClear()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    route.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { handled: false }
    })
    const pending = call(dispatcher, params, CLIENT, unary)
    await entered.promise
    if (unary) {
      rows = []
    } else {
      sourceRow.worktreeId = 'replacement-workspace'
      sourceRow.providerSession.id = 'replacement-thread'
      sourceRow.providerSession.transcriptPath = join(root, 'replacement.jsonl')
    }
    release.resolve()
    expect(await pending).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
    })
    expect(store.getRecord(SESSION)?.accountHome).toMatchObject({ path: originalHome })
    await rm(transcriptPath)
    selectedHome = driftedHome
    setStructuredAgentSessionHost(null)
    internal.ensureStructuredAgentSessionHost = vi.fn(async () => {
      setStructuredAgentSessionHost(host)
    })
    sourceRows.mockImplementation(() => {
      if (!unary) {
        throw new Error('source snapshot unavailable')
      }
      return []
    })

    expect(await call(dispatcher, params)).toMatchObject({
      ok: true,
      result: {
        ok: true,
        replayed: true,
        value: {
          page: {
            items: expect.arrayContaining([
              expect.objectContaining({
                body: expect.objectContaining({
                  blocks: expect.arrayContaining([
                    expect.objectContaining({ text: 'durable adopted history' })
                  ])
                })
              })
            ])
          }
        }
      }
    })
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
    expect(internal.publishStructuredAgentSessionTab).toHaveBeenCalledTimes(2)
    expect(selectAccountHome).toHaveBeenCalledTimes(1)
    // The switched-out terminal is checked before the owner is named; an unavailable scan refuses.
    const another = await call(dispatcher, createParams(OPERATION, 'another-chat'))
    expect(another).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { details: { reason: 'conversationHeldElsewhere' } } }
    })
    expect(JSON.stringify(another).includes(`"owner"`)).toBe(unary)

    // Only an exact committed replay bypasses an unavailable writer scan.
    const freshRefusal = unary
      ? { code: 'agent_session_identity_required' }
      : { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
    const otherOperation = createParams(`${Date.now()}-00000000000000000000000000000002`)
    expect(await call(dispatcher, otherOperation)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: freshRefusal }
    })
    expect(await call(dispatcher, params, { ...CLIENT, clientId: 'device-b' })).toMatchObject({
      ok: true,
      result: { ok: false, refusal: freshRefusal }
    })
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
    expect(internal.publishStructuredAgentSessionTab).toHaveBeenCalledTimes(2)
  })
})
