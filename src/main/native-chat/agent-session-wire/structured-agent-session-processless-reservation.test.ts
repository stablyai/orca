import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { createStructuredAgentSessionOwnerProbe } from '../../runtime/structured-agent-session-runtime'
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
let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function attachParams(): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
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
  it('persists pre-spawn proof so restart can release only the proven reservation', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-processless-reservation-'))
    const storeDir = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    const adapter = {
      acquire: vi.fn(async () => {
        throw new AgentSessionPreSpawnError(new Error('workspace no longer exists'))
      })
    } as unknown as StructuredAgentSessionAdapter

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
    expect(store.getRecord(SESSION)?.lease.processlessAt).toBe(NOW)

    const reopened = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    await reopened.reconcileOnRestart({
      probe: async (record) =>
        record.lease.processlessAt === NOW
          ? { outcome: 'reservation-unused' }
          : { outcome: 'indeterminate', reason: 'missing pre-spawn proof' },
      now: NOW + 1
    })
    expect(reopened.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 2,
      reservedSpawnToken: null
    })
  })

  it('consumes stale pre-spawn proof before a retry can spawn', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-processless-retry-'))
    const storeDir = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    const adapter = {
      acquire: vi
        .fn<StructuredAgentSessionAdapter['acquire']>()
        .mockRejectedValueOnce(new AgentSessionPreSpawnError(new Error('launch not ready')))
        .mockResolvedValueOnce({
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: NOW,
            spawnToken: 'spawn-a'
          },
          link: {
            linkId: 'link-1',
            handle: { provider: 'codex', threadId: 'thread-1' },
            origin: 'created',
            mintedAtFence: 1,
            observedAt: NOW
          }
        })
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
    expect(store.getRecord(SESSION)?.lease.processlessAt).toBe(NOW)
    vi.spyOn(store, 'commitProcessIdentity').mockRejectedValueOnce(new Error('simulated crash'))

    await expect(performAttach(input)).rejects.toThrow('simulated crash')

    const reopened = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    expect(reopened.getRecord(SESSION)?.lease.processlessAt).toBeNull()
    await reopened.reconcileOnRestart({
      probe: createStructuredAgentSessionOwnerProbe('local'),
      now: NOW + 1
    })
    expect(reopened.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'recovering',
      runtimeFence: 1,
      processlessAt: null
    })
  })
})
