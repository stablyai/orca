import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { isAgentSessionRecord } from '../../shared/agent-session-record'
import { optionRecord } from '../harness-conversation/machine-structured-session-values'
import { readNativeSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'
import { AgentSessionRecordStore } from './agent-session-record-store'

const NOW = 1_800_000_000_000
const SESSION = 'session-options'
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-options-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('fails option hydration before ownership can be proved', async () => {
  await expect(
    readNativeSessionOptions({
      adapter: {
        readOptions: async () => {
          throw new Error('model list unavailable')
        }
      },
      sessionId: SESSION,
      fence: 2
    })
  ).rejects.toThrow('model list unavailable')
})

it('drops provider-rejected persisted options before the next owner proof', async () => {
  await expect(
    readNativeSessionOptions({
      adapter: {
        readOptions: async () => ({ models: [], current: { model: 'provider-model' } }),
        readOptionRestoreFailures: () => ['permissionMode']
      },
      sessionId: SESSION,
      fence: 2,
      priorOptions: { permissionMode: 'retired-mode', other: 'keep' }
    })
  ).resolves.toEqual({ model: 'provider-model', other: 'keep' })
})

it.each([
  { current: { model: 'gpt-tui', effort: 'low' }, expected: { model: 'gpt-tui', effort: 'low' } },
  { current: { model: '' }, expected: {} }
])(
  'persists provider options $current atomically with owner proof',
  async ({ current, expected }) => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const reserved = await store.reserveOwner({
      sessionId: SESSION,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      runtimeKind: 'native',
      expectedFence: null,
      spawnToken: 'spawn-options',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'indeterminate', reason: 'new session' },
      operation: {
        callerKey: 'client-1',
        operationId: '1800000000000-00000000000000000000000000000000',
        fingerprint: 'options-create'
      },
      now: NOW
    })
    const fence = reserved.record.lease.runtimeFence
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence,
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: NOW - 1,
        spawnToken: 'spawn-options'
      },
      now: NOW
    })
    const options = await readNativeSessionOptions({
      adapter: {
        readOptions: async () => ({
          models: [],
          current
        })
      },
      sessionId: SESSION,
      fence
    })
    const proof = {
      sessionId: SESSION,
      fence,
      link: {
        linkId: 'codex-options-1',
        handle: { provider: 'codex' as const, threadId: 'thread-options' },
        origin: 'created' as const,
        mintedAtFence: fence,
        observedAt: NOW
      },
      now: NOW,
      ...(options ? { options } : {})
    }
    await expect(store.proveOwner({ ...proof, options: { model: '' } })).rejects.toThrow(
      'agent_session_options_invalid'
    )
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('reserved')
    await store.proveOwner(proof)

    await expect(
      store.replaceSessionOptions({ sessionId: SESSION, fence, options: { model: '' }, now: NOW })
    ).rejects.toThrow('agent_session_options_invalid')

    const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(reopened.getRecord(SESSION)?.options).toEqual(expected)
    expect(reopened.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(isAgentSessionRecord(reopened.getRecord(SESSION))).toBe(true)
  }
)

it('omits unknown and empty option values without dropping false', () => {
  expect(
    optionRecord({
      commands: [],
      canCompact: false,
      canFork: false,
      options: [
        {
          id: 'model',
          label: 'Model',
          valueSource: 'unknown',
          transport: 'agent-session',
          settable: true,
          kind: { type: 'select', choices: [], currentValue: '' }
        },
        {
          id: 'effort',
          label: 'Effort',
          valueSource: 'unknown',
          transport: 'agent-session',
          settable: true,
          kind: { type: 'select', choices: [] }
        },
        {
          id: 'fastMode',
          label: 'Fast',
          valueSource: 'applied',
          transport: 'agent-session',
          settable: true,
          kind: { type: 'boolean', currentValue: false }
        }
      ]
    })
  ).toEqual({ fastMode: 'false' })
})
