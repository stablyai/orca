import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_SWARM_METHODS } from './structured-agent-session-swarm'
import {
  call as callStructured,
  clearStructuredHostStub,
  hostStub
} from '../protocol/structured-agent-session-rpc.test-fixture'
import {
  SESSION,
  STRUCTURED_CLIENT
} from '../protocol/structured-agent-session-rpc-client.test-fixture'

type CallClient = Parameters<typeof callStructured>[2]

function call(method: string, params: unknown, client: CallClient) {
  return callStructured(method, params, client, {}, STRUCTURED_AGENT_SESSION_SWARM_METHODS)
}

let tempRoot: string
let geminiHome: string
let record: AgentSessionRecord | null
let launchAccountHome: ReturnType<typeof vi.fn>

function antigravitySwarmRecord(
  locationOverrides: Partial<AgentSessionRecord['location']> = {}
): AgentSessionRecord {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: SESSION }))
  return {
    ...base,
    provider: 'antigravity',
    location: {
      ...base.location,
      ...locationOverrides
    },
    accountHome: { variable: 'GEMINI_HOME', path: geminiHome },
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: base.lease.runtimeFence,
        observedAt: 1_000,
        handle: { transport: 'acp', agent: 'antigravity', nativeId: 'swarm-coord-1' }
      }
    ]
  }
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-swarm-rpc-'))
  geminiHome = join(tempRoot, '.gemini')
  const brainDir = join(geminiHome, 'antigravity-cli', 'brain')
  const swarmDir = join(brainDir, 'swarm-coord-1', '.system_generated', 'swarm')
  const workerLogsDir = join(brainDir, 'swarm-worker-1', '.system_generated', 'logs')
  await Promise.all([
    mkdir(swarmDir, { recursive: true }),
    mkdir(workerLogsDir, { recursive: true })
  ])
  await writeFile(
    join(swarmDir, 'members.json'),
    JSON.stringify({
      title: 'Swarm RPC Test',
      members: {
        coordinator: { conversation_id: 'swarm-coord-1', role: 'coordinator', last_read_seq: 1 },
        worker: { conversation_id: 'swarm-worker-1', role: 'worker', last_read_seq: 0 }
      }
    })
  )
  await writeFile(
    join(swarmDir, 'board.jsonl'),
    `${JSON.stringify({ seq: 1, agent: 'coordinator', text: 'Start', time: '2026-11-17 10:00:00' })}\n`
  )
  await writeFile(
    join(workerLogsDir, 'transcript.jsonl'),
    `${JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: 'Investigate swarm'
    })}\n`
  )

  record = antigravitySwarmRecord()
  launchAccountHome = vi.fn(async () => null)
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      deps: {
        store: {
          getRecord: (id: string) => (record?.sessionId === id ? record : null)
        },
        launchAccountHome
      }
    })
  )
})

afterEach(async () => {
  clearStructuredHostStub()
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3 })
})

describe('agentSession.swarmRead & agentSession.swarmMemberTranscript', () => {
  it('reads local host swarm snapshot and worker transcript', async () => {
    const readRes = await call('agentSession.swarmRead', { sessionId: SESSION }, STRUCTURED_CLIENT)
    expect(readRes).toMatchObject({
      ok: true,
      result: { status: 'ok', snapshot: { title: 'Swarm RPC Test', swarmId: 'swarm-coord-1' } }
    })

    const transcriptRes = await call(
      'agentSession.swarmMemberTranscript',
      { sessionId: SESSION, conversationId: 'swarm-worker-1' },
      STRUCTURED_CLIENT
    )
    expect(transcriptRes).toMatchObject({
      ok: true,
      result: { status: 'ok', conversationId: 'swarm-worker-1' }
    })
  })

  it('returns unsupported without reading local fs or launchAccountHome for SSH and WSL sessions', async () => {
    for (const location of [
      { executionHostId: 'ssh:remote-box' as const, wslDistro: null },
      { executionHostId: 'local' as const, wslDistro: 'Ubuntu' }
    ]) {
      record = antigravitySwarmRecord(location)
      launchAccountHome.mockClear()

      expect(
        await call('agentSession.swarmRead', { sessionId: SESSION }, STRUCTURED_CLIENT)
      ).toMatchObject({ ok: true, result: { status: 'unsupported' } })

      expect(
        await call(
          'agentSession.swarmMemberTranscript',
          { sessionId: SESSION, conversationId: 'swarm-worker-1' },
          STRUCTURED_CLIENT
        )
      ).toMatchObject({ ok: true, result: { status: 'unsupported' } })

      expect(launchAccountHome).not.toHaveBeenCalled()
    }
  })
})
