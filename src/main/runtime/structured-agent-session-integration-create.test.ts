// A chat's create, driven over `agentSession.*` with everything but the Codex child real: it
// founds the chat at rest, its replay starts nothing, its first message starts the agent (resuming
// an adopted conversation), and a chat an older host failed to start can be created again.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { ensureStructuredAgentSessionHost } from './structured-agent-session-runtime'
import {
  openStructuredCodexRpcHarness,
  SESSION,
  type StructuredCodexRpcHarness
} from './structured-codex-session-rpc-test-harness'

const ADOPTED_THREAD = 'thread-adopted-earlier'

let harness: StructuredCodexRpcHarness

beforeEach(async () => {
  harness = await openStructuredCodexRpcHarness()
})

afterEach(async () => {
  await harness.dispose()
})

async function send(fence: number, text: string) {
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  return harness.ok('agentSession.send', {
    envelope: harness.envelope('agentSession.send', { body }, fence),
    body
  })
}

function startedTurn(): Promise<void> {
  return vi.waitFor(() =>
    expect(harness.codex.live().calls).toContainEqual(
      expect.objectContaining({ method: 'turn/start' })
    )
  )
}

/** The intent the RPC resolver builds, with the adoption it resolves for a "resume" create. */
function adoptingCreate(transcriptPath: string): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      ...harness.envelope('agentSession.create', {}, null),
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    adopt: { providerHandle: { kind: 'codex', threadId: ADOPTED_THREAD }, transcriptPath }
  }
  params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId: SESSION,
    fields: attachFingerprintFields(params)
  })
  return params
}

describe('creating a structured codex chat over agentSession.*', () => {
  it('stays at rest when the same create is replayed, and its first send starts the agent', async () => {
    const params = harness.createIntentParams()
    const created = await harness.ok<{ fence: number }>('agentSession.create', params)
    const replay = await harness.call('agentSession.create', params)

    expect(replay).toMatchObject({ ok: true, result: { ok: true, replayed: true, fence: 1 } })
    expect(harness.codex.connections).toHaveLength(0)

    await send(created.fence, 'go')
    await startedTurn()
    expect(harness.codex.connections).toHaveLength(1)
  })

  it('answers agentSession.ensure as a method that no longer exists', async () => {
    expect(await harness.call('agentSession.ensure', harness.createIntentParams())).toMatchObject({
      ok: false,
      error: { code: 'method_not_found' }
    })
  })

  it('resumes the adopted conversation when its first message starts the agent', async () => {
    const transcriptPath = join(harness.root, 'adopted-rollout.jsonl')
    const rollout = [
      { type: 'session_meta', payload: { id: ADOPTED_THREAD, cwd: '/repos/workspace-1' } },
      {
        type: 'response_item',
        timestamp: '2026-09-06T18:00:01.000Z',
        payload: { type: 'message', role: 'user', content: 'from before' }
      }
    ]
    await writeFile(transcriptPath, `${rollout.map((line) => JSON.stringify(line)).join('\n')}\n`)
    const host = await ensureStructuredAgentSessionHost(harness.hostConfig())
    const created = await host.create({ callerKey: 'client-1' }, adoptingCreate(transcriptPath))
    expect(created).toMatchObject({ ok: true, fence: 1 })
    expect(harness.codex.connections).toHaveLength(0)

    await send(1, 'carry on')
    await startedTurn()

    expect(harness.codex.live().resumedThreadId).toBe(ADOPTED_THREAD)
    expect(harness.codex.live().calls).not.toContainEqual(
      expect.objectContaining({ method: 'thread/start' })
    )
  })

  it('creates again a chat whose start an older host ran at create and lost', async () => {
    // What an older host left: the create reserved the record, its start failed and was proven
    // gone, and the renderer kept the chat as a failed launch it relaunches under a new operation.
    const host = await ensureStructuredAgentSessionHost(harness.hostConfig())
    const { store } = host.deps
    const now = Date.now()
    const location: AgentSessionExecutionLocation = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    }
    const identity = {
      sessionId: SESSION,
      location,
      provider: 'codex' as const,
      accountHome: { variable: 'CODEX_HOME' as const, path: '/home/dev/.codex' }
    }
    const oldCreate = { callerKey: 'client-1', operationId: `${now}-${'a'.repeat(32)}` }
    await store.createAtRest({
      ...identity,
      claimKeyId: 'key-1',
      operation: { ...oldCreate, fingerprint: 'old-create' },
      now
    })
    const reserved = await store.reserveOwner({
      ...identity,
      expectedFence: 1,
      spawnToken: 'spawn-old',
      claimKeyId: 'key-1',
      handoffOperationId: oldCreate.operationId,
      probe: { outcome: 'reservation-unused' },
      operation: { ...oldCreate, fingerprint: 'old-create' },
      now
    })
    await store.settleFailedAcquisition({
      sessionId: SESSION,
      fence: reserved.record.lease.runtimeFence,
      spawnToken: 'spawn-old',
      ...oldCreate,
      outcome: { status: 'failed', code: 'agent_session_operation_invalid', message: 'signed out' },
      exitProof: 'exit-proven',
      now
    })
    const left = store.getRecord(SESSION)
    expect(left?.providerHandleChain).toEqual([])

    const created = await harness.ok<{ fence: number }>(
      'agentSession.create',
      harness.createIntentParams()
    )
    // Founded again at rest, one fence past the failed start's: a fence never moves back.
    expect(created.fence).toBe((left?.lease.runtimeFence ?? 0) + 1)
    await send(created.fence, 'signed in now')
    await startedTurn()
  })
})
