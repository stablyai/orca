import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const SESSION = 'session-adoption-replay'
const THREAD = 'thread-adoption-replay'
const WORKSPACE = 'workspace-1'
const OPERATION = `${Date.now()}-00000000000000000000000000000001`
const CLIENT = {
  clientId: 'device-a',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

let root: string
let host: StructuredAgentSessionHost

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
          handle: { provider: 'codex', threadId: THREAD },
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

function createParams(operationId = OPERATION) {
  const fields = {
    worktree: `id:${WORKSPACE}`,
    agent: 'codex' as const,
    resumeFrom: { providerSessionId: THREAD }
  }
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  }
}

async function call(dispatcher: RpcDispatcher, params: unknown, client = CLIENT) {
  const replies: RpcResponse[] = []
  const request: RpcRequest = {
    id: `request-${replies.length + 1}`,
    authToken: 'token',
    method: 'agentSession.create',
    params
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
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await host?.flushAllStreamedEvents()
  await host?.close(SESSION)
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('committed adopting create RPC replay', () => {
  it('republishes from durable identity after the source disappears and account selection drifts', async () => {
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
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          experimentalStructuredNativeChat: true,
          agentDefaultEnv: { codex: {} }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch: selectAccountHome }
    )
    // The structured surface is settings-gated for every caller, not just mobile; this test
    // probes durable-identity replay, which only runs once the gate admits the call.
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      experimentalStructuredNativeChat: true
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

    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const sessionAdapter = adapter()
    host = new StructuredAgentSessionHost({
      store,
      adapter: sessionAdapter,
      journalRoot: root,
      claimKeyId: 'key-1'
    })
    setStructuredAgentSessionHost(host)
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: STRUCTURED_AGENT_SESSION_METHODS
    })
    const params = createParams()

    expect(await call(dispatcher, params)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
    })
    await rm(transcriptPath)
    selectedHome = driftedHome
    setStructuredAgentSessionHost(null)
    internal.ensureStructuredAgentSessionHost = vi.fn(async () => {
      setStructuredAgentSessionHost(host)
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

    const otherOperation = createParams(`${Date.now()}-00000000000000000000000000000002`)
    expect(await call(dispatcher, otherOperation)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_identity_required' } }
    })
    expect(await call(dispatcher, params, { ...CLIENT, clientId: 'device-b' })).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_identity_required' } }
    })
    expect(sessionAdapter.acquire).toHaveBeenCalledTimes(1)
    expect(internal.publishStructuredAgentSessionTab).toHaveBeenCalledTimes(2)
  })
})
