import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
const NEXT_OPERATION = `${NOW}-${'2'.padStart(32, '0')}`
let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function attachParams(
  operationId = OPERATION,
  expectedRuntimeFence: number | null = null
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId,
      expectedRuntimeFence,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

describe('processless structured session reservation', () => {
  it('settles a pre-spawn failure and its processless evidence in one durable transaction', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-processless-reservation-'))
    const storeDir = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    const adapter = {
      acquire: vi.fn(async () => {
        throw new AgentSessionPreSpawnError(new Error('workspace no longer exists'))
      })
    } as unknown as StructuredAgentSessionAdapter
    const processlessProof = vi.spyOn(store, 'setReservationProcesslessProof')
    const settlement = vi.spyOn(store, 'settleFailedAcquisition')

    await expect(
      performAttach({
        store,
        adapter,
        journalRoot: root,
        authority: {
          spawnToken: 'spawn-a',
          claimKeyId: 'key-1',
          handoffOperationId: OPERATION,
          probe: { outcome: 'reservation-unused' }
        },
        callerKey: 'client-1',
        params: attachParams(),
        now: () => NOW,
        onAttached: () => {}
      })
    ).rejects.toThrow('workspace no longer exists')
    expect(settlement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ exitProof: 'processless', spawnToken: 'spawn-a' })
    )
    // No separate durable proof write: the only proof call is acquisition's single-use clear.
    expect(processlessProof).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ processlessAt: null })
    )
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      handoffOperationId: null,
      runtimeFence: 2,
      processlessAt: null,
      reservedSpawnToken: null,
      deathEvidence: { kind: 'pid-absent', detail: 'reservation failed before spawn' }
    })
    expect(store.listOperationRows()[0]?.outcome).toMatchObject({ status: 'failed' })

    const reopened = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no owner to probe' }),
      now: NOW + 1
    })
    expect(reopened.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 2,
      reservedSpawnToken: null
    })
  })

  it('does not rerun a settled pre-spawn failure and admits a fresh operation', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-processless-retry-'))
    const storeDir = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    const adapter = {
      acquire: vi
        .fn<StructuredAgentSessionAdapter['acquire']>()
        .mockRejectedValueOnce(new AgentSessionPreSpawnError(new Error('launch not ready')))
        .mockImplementationOnce(async ({ fence, spawnToken }) => ({
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: NOW,
            spawnToken
          },
          link: {
            linkId: 'link-1',
            handle: { provider: 'codex', threadId: 'thread-1' },
            origin: 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        })),
      releaseAcquisition: vi.fn(async () => true)
    } as unknown as StructuredAgentSessionAdapter
    const input = {
      store,
      adapter,
      journalRoot: root,
      authority: {
        spawnToken: 'spawn-a',
        claimKeyId: 'key-1',
        handoffOperationId: OPERATION,
        probe: { outcome: 'reservation-unused' as const }
      },
      callerKey: 'client-1',
      params: attachParams(),
      now: () => NOW,
      onAttached: () => {}
    }

    await expect(performAttach(input)).rejects.toThrow('launch not ready')
    await expect(performAttach(input)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(adapter.acquire).toHaveBeenCalledOnce()

    await expect(
      performAttach({
        ...input,
        authority: {
          ...input.authority,
          spawnToken: 'spawn-b',
          handoffOperationId: NEXT_OPERATION
        },
        params: attachParams(NEXT_OPERATION, 2)
      })
    ).resolves.toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 3,
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })
})
