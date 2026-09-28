import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { codexProviderHandleLink } from '../codex/codex-structured-owner-identity'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const SESSION = 'session-codex'
let directory: string
let operations = 0

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  operations += 1
  return {
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    expectedFence: null,
    spawnToken: `spawn-${operations}`,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${String(operations).padStart(32, '0')}`,
      fingerprint: `fp-${operations}`
    },
    now: NOW,
    ...overrides
  }
}

/** Reserve, observe the spawn and prove the link the adapter reported, as the host does. */
async function prove(
  store: AgentSessionRecordStore,
  request: AgentSessionReserveRequest,
  link: (fence: number) => AgentSessionProviderHandleLink
) {
  const { record } = await store.reserveOwner(request)
  const fence = record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: {
      hostId: 'local',
      pid: 4242 + fence,
      processStartTimeMs: NOW,
      spawnToken: record.lease.reservedSpawnToken ?? ''
    },
    now: NOW
  })
  return store.proveOwner({ sessionId: SESSION, fence, link: link(fence), now: NOW })
}

/** A restart: the previous owner is gone and the reopened store adjudicates it. */
async function restart(store: AgentSessionRecordStore) {
  const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
  await store.evictProvenDeadOwner({
    sessionId: SESSION,
    expectedFence: fence,
    probe: { outcome: 'exit-observed' },
    now: NOW
  })
  const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  await reopened.reconcileOnRestart({
    probe: async () => ({ outcome: 'reservation-unused' }),
    now: NOW
  })
  return reopened
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-supersession-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('a Codex thread started in place of one Codex never saved', () => {
  it('becomes the session identity and survives the next restart', async () => {
    const first = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await prove(first, reserveRequest(), (fence) =>
      codexProviderHandleLink({
        threadId: 'thread-unsaved',
        resumed: false,
        fence,
        observedAt: NOW
      })
    )

    const second = await restart(first)
    const expectedFence = second.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const proved = await prove(second, reserveRequest({ expectedFence }), (fence) =>
      codexProviderHandleLink({
        threadId: 'thread-new',
        resumed: false,
        supersedesThreadId: 'thread-unsaved',
        fence,
        observedAt: NOW
      })
    )

    expect(proved.lease.claimStatus).toBe('live')
    expect(proved.providerHandleChain).toEqual([
      expect.objectContaining({
        handle: { provider: 'codex', threadId: 'thread-new' },
        origin: 'created',
        supersedesKey: 'codex:"thread-unsaved"'
      })
    ])
    expect(proved.lease.provenHandleLinkId).toBe(proved.providerHandleChain[0]?.linkId)

    const third = await restart(second)
    expect(third.getRecord(SESSION)?.providerHandleChain).toEqual(proved.providerHandleChain)
  })

  it('is refused once a resume has proved the conversation Codex saved', async () => {
    const first = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await prove(first, reserveRequest(), (fence) =>
      codexProviderHandleLink({ threadId: 'thread-saved', resumed: false, fence, observedAt: NOW })
    )
    const second = await restart(first)
    await prove(
      second,
      reserveRequest({ expectedFence: second.getRecord(SESSION)?.lease.runtimeFence ?? 0 }),
      (fence) =>
        codexProviderHandleLink({ threadId: 'thread-saved', resumed: true, fence, observedAt: NOW })
    )

    const third = await restart(second)
    await expect(
      prove(
        third,
        reserveRequest({ expectedFence: third.getRecord(SESSION)?.lease.runtimeFence ?? 0 }),
        (fence) =>
          codexProviderHandleLink({
            threadId: 'thread-new',
            resumed: false,
            supersedesThreadId: 'thread-saved',
            fence,
            observedAt: NOW
          })
      )
    ).rejects.toThrow('agent_session_provider_handle_invalid')
    expect(third.getRecord(SESSION)?.providerHandleChain).toHaveLength(2)
  })
})
