import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'

const NOW = 1_800_000_000_000
const SESSION = 'legacy-session'
const CREATE_OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
const RESUME_OPERATION = `${NOW}-${'2'.padStart(32, '0')}`
let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function attachParams(
  operationId: string,
  expectedRuntimeFence: number | null
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
    providerHandle: { kind: 'codex', threadId: 'legacy-thread' }
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

function adapter(input: {
  origin: 'created' | 'resumed'
  options?: AgentSessionOptionsResult
}): StructuredAgentSessionAdapter {
  return {
    acquire: vi
      .fn<StructuredAgentSessionAdapter['acquire']>()
      .mockImplementation(async ({ fence, spawnToken }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: NOW,
          spawnToken
        },
        link: {
          linkId: `${input.origin}-link`,
          handle: { provider: 'codex', threadId: 'legacy-thread' },
          origin: input.origin,
          mintedAtFence: fence,
          observedAt: NOW
        }
      })),
    ...(input.options ? { readOptions: vi.fn(async () => input.options!) } : {}),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

function expectSettledAttachLease(record: AgentSessionRecord | null): void {
  expect(record).not.toBeNull()
  const lease = record!.lease
  const durableState = lease.handoffStage ?? lease.claimStatus
  expect(['live', 'released', 'recovering', 'manual-recovery']).toContain(durableState)
  expect(lease.handoffStage).not.toBe('new-owner-proving')
}

describe('structured session acquisition options', () => {
  it('persists provider options before proving a resumed legacy record', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-acquisition-options-'))
    const storeDir = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })

    const created = await performAttach({
      store,
      adapter: adapter({ origin: 'created' }),
      journalRoot: root,
      authority: {
        spawnToken: 'spawn-a',
        claimKeyId: 'key-1',
        handoffOperationId: CREATE_OPERATION,
        probe: { outcome: 'reservation-unused' }
      },
      callerKey: 'client-1',
      params: attachParams(CREATE_OPERATION, null),
      now: () => NOW,
      onAttached: () => {}
    })
    expect(created).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.options).toBeUndefined()
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      options: { approvalPolicy: 'on-request', personality: 'concise' },
      now: NOW
    })

    const resumedStore = await AgentSessionRecordStore.open({
      directory: storeDir,
      hostId: 'local'
    })
    await resumedStore.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: NOW + 1
    })
    const releasedFence = resumedStore.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const resumed = await performAttach({
      store: resumedStore,
      adapter: adapter({
        origin: 'resumed',
        options: {
          current: { model: 'gpt-5.6-terra', effort: 'medium' },
          models: []
        }
      }),
      journalRoot: root,
      authority: {
        spawnToken: 'spawn-b',
        claimKeyId: 'key-1',
        handoffOperationId: RESUME_OPERATION,
        probe: { outcome: 'reservation-unused' }
      },
      callerKey: 'client-1',
      params: attachParams(RESUME_OPERATION, releasedFence),
      now: () => NOW + 1,
      onAttached: () => {}
    })

    expect(resumed).toMatchObject({ ok: true })
    const reopened = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    expect(reopened.getRecord(SESSION)?.options).toEqual({
      approvalPolicy: 'on-request',
      personality: 'concise',
      model: 'gpt-5.6-terra',
      effort: 'medium'
    })
  })

  it('releases an acquisition when provider options cannot be read', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-acquisition-options-failure-'))
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const releaseAcquisition = vi.fn(async () => true)
    const failingAdapter: StructuredAgentSessionAdapter = {
      ...adapter({ origin: 'created' }),
      readOptions: vi.fn(async () => {
        throw new Error('model list unavailable')
      }),
      releaseAcquisition
    }

    await expect(
      performAttach({
        store,
        adapter: failingAdapter,
        journalRoot: root,
        authority: {
          spawnToken: 'spawn-a',
          claimKeyId: 'key-1',
          handoffOperationId: CREATE_OPERATION,
          probe: { outcome: 'reservation-unused' }
        },
        callerKey: 'client-1',
        params: attachParams(CREATE_OPERATION, null),
        now: () => NOW,
        onAttached: () => {}
      })
    ).rejects.toThrow('model list unavailable')
    expect(releaseAcquisition).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.ownerProcess).toBeNull()
  })

  describe.each([
    ['adapter acquire', 'acquire'],
    ['options read', 'options'],
    ['identity commit', 'identity'],
    ['owner proof', 'proof'],
    ['journal attach', 'journal']
  ] as const)('%s failure', (_label, failurePoint) => {
    it.each([
      ['proven cleanup', true],
      ['unproven cleanup', false],
      ['cleanup error', 'throws']
    ] as const)('atomically settles the lease and operation after %s', async (_case, cleanup) => {
      const exitProven = cleanup === true
      root = await mkdtemp(join(tmpdir(), `orca-acquisition-${failurePoint}-`))
      const storeDir = join(root, 'store')
      const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
      const base = adapter({
        origin: 'created',
        options: { current: { model: 'gpt-5.6-terra' }, models: [] }
      })
      const injected = new Error(`${failurePoint} failed`)
      const acquire = vi.mocked(base.acquire)
      const readOptions = vi.mocked(base.readOptions!)
      if (failurePoint === 'acquire') {
        acquire.mockRejectedValueOnce(injected)
      } else if (failurePoint === 'options') {
        readOptions.mockRejectedValueOnce(injected)
      } else if (failurePoint === 'identity') {
        vi.spyOn(store, 'commitProcessIdentity').mockRejectedValueOnce(injected)
      } else if (failurePoint === 'proof') {
        vi.spyOn(store, 'proveOwner').mockRejectedValueOnce(injected)
      } else if (failurePoint === 'journal') {
        acquire.mockImplementation(async ({ fence, spawnToken }) => ({
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: NOW,
            spawnToken
          },
          link: {
            linkId: `link-${fence}`,
            handle: { provider: 'codex', threadId: 'legacy-thread' },
            origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }))
      }
      const releaseAcquisition = vi.fn(async () => {
        if (cleanup === 'throws') {
          throw new Error('cleanup failed')
        }
        return cleanup
      })
      const failingAdapter = {
        ...base,
        acquire,
        readOptions,
        releaseAcquisition,
        ...(failurePoint === 'journal'
          ? { historyFilePath: vi.fn().mockRejectedValueOnce(injected).mockResolvedValue(null) }
          : {})
      }
      const perform = (
        target: AgentSessionRecordStore,
        operationId: string,
        fence: number | null
      ) =>
        performAttach({
          store: target,
          adapter: failingAdapter,
          journalRoot: root!,
          authority: {
            spawnToken: operationId === CREATE_OPERATION ? 'spawn-a' : 'spawn-b',
            claimKeyId: 'key-1',
            handoffOperationId: operationId,
            probe: { outcome: 'reservation-unused' }
          },
          callerKey: 'client-1',
          params: attachParams(operationId, fence),
          now: () => NOW,
          onAttached: () => {}
        })

      await expect(perform(store, CREATE_OPERATION, null)).rejects.toThrow(
        exitProven ? injected.message : 'agent_session_acquisition_exit_unproven'
      )

      const reopened = await AgentSessionRecordStore.open({
        directory: storeDir,
        hostId: 'local'
      })
      const failedRecord = reopened.getRecord(SESSION)
      expectSettledAttachLease(failedRecord)
      expect(
        reopened.listOperationRows().find((row) => row.operationId === CREATE_OPERATION)?.outcome
      ).toMatchObject({ status: 'failed' })

      await reopened.reconcileOnRestart({
        probe: async (record) =>
          exitProven || record.lease.ownerProcess === null
            ? exitProven
              ? { outcome: 'reservation-unused' }
              : { outcome: 'indeterminate', reason: 'owner identity was never committed' }
            : { outcome: 'identity-matched', matchedOn: ['process-start-time'] },
        now: NOW + 1
      })

      if (exitProven) {
        expect(failedRecord?.lease).toMatchObject({
          runtimeFence: 2,
          claimStatus: 'released',
          handoffStage: null,
          handoffOperationId: null,
          ownerProcess: null,
          reservedSpawnToken: null
        })
        await expect(perform(reopened, RESUME_OPERATION, 2)).resolves.toMatchObject({ ok: true })
        expectSettledAttachLease(reopened.getRecord(SESSION))
      } else {
        expect(failedRecord?.lease).toMatchObject({
          runtimeFence: 1,
          claimStatus: failurePoint === 'journal' ? 'live' : 'reserved',
          handoffStage:
            failurePoint === 'proof' || failurePoint === 'journal'
              ? 'recovering'
              : 'manual-recovery',
          // The settled operation must not stay named by the lease as an in-flight transfer.
          handoffOperationId: null,
          reservedSpawnToken: 'spawn-a'
        })
        await expect(perform(reopened, RESUME_OPERATION, 1)).resolves.toMatchObject({
          ok: false,
          refusal: { code: 'agent_session_ownership_unknown' }
        })
      }
    })
  })
})
