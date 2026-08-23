import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
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
    const releaseAcquisition = vi.fn(async () => undefined)
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
})
