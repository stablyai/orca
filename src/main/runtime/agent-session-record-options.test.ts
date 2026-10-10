import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readNativeSessionOptions } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { AcpStructuredOptions } from '../acp/acp-structured-options'
import { NewSessionResponseSchema } from '../acp/generated/acp-protocol.generated'
import { replaceAgentSessionRecordOptions } from './agent-session-record-options'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

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

it('omits empty model values from other option producers', async () => {
  await expect(
    readNativeSessionOptions({
      adapter: { readOptions: async () => ({ models: [], current: { model: '', effort: 'off' } }) },
      sessionId: SESSION,
      fence: 2,
      priorOptions: { model: 'old-model', other: 'keep' }
    })
  ).resolves.toEqual({ effort: 'off', other: 'keep' })
})

it('durably replaces model-less ACP options when a later report reaches the option writer', async () => {
  const response = NewSessionResponseSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../acp/fixtures/omp-v17-windows-new-no-model.json', import.meta.url),
        'utf8'
      )
    )
  )
  const reader = new AcpStructuredOptions()
  reader.adoptSession(response)
  const fixture = agentSessionRecordFixture()
  const record = {
    ...fixture,
    provider: 'omp',
    options: reader.reported(),
    providerHandleChain: fixture.providerHandleChain.map((link) => ({
      ...link,
      handle: { transport: 'acp', agent: 'omp', nativeId: response.sessionId }
    }))
  }
  await seedTestAgentSessionRecordStore(directory, { records: [record] })
  const store = await openTestAgentSessionRecordStore(directory)
  expect(store.getRecord(record.sessionId)?.options).toEqual({ effort: 'off' })

  reader.adoptConfigOptions([
    ...(response.configOptions ?? []),
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'reported-model',
      options: [{ value: 'reported-model', name: 'Reported Model' }]
    }
  ])
  const options = await readNativeSessionOptions({
    adapter: { readOptions: async () => reader.read() },
    sessionId: record.sessionId,
    fence: record.lease.runtimeFence,
    priorOptions: store.getRecord(record.sessionId)?.options
  })
  if (!options) {
    throw new Error('The later ACP report must provide options')
  }
  await store.replaceSessionOptions({
    sessionId: record.sessionId,
    fence: record.lease.runtimeFence,
    options,
    now: NOW
  })
  const reopened = await openTestAgentSessionRecordStore(directory)
  expect(reopened.getRecord(record.sessionId)?.options).toEqual({
    model: 'reported-model',
    effort: 'off'
  })
})

it('persists resumed provider options atomically with owner proof', async () => {
  const store = await openTestAgentSessionRecordStore(directory)
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
        current: { model: 'gpt-tui', effort: 'low' }
      })
    },
    sessionId: SESSION,
    fence
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'codex-options-1',
      handle: codexProviderHandle('thread-options'),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW,
    ...(options ? { options } : {})
  })

  const reopened = await openTestAgentSessionRecordStore(directory)
  expect(reopened.getRecord(SESSION)?.options).toEqual({ model: 'gpt-tui', effort: 'low' })
})

it('keeps who chose the model through a reopen, a report of it and a replacement, until it changes', async () => {
  const store = await openTestAgentSessionRecordStore(directory)
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
    options: { model: 'opus', effort: 'high' },
    modelChosenBy: 'picker',
    expectedFence: null,
    spawnToken: 'spawn-source',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'new session' },
    operation: {
      callerKey: 'client-1',
      operationId: '1800000000000-00000000000000000000000000000001',
      fingerprint: 'source-create'
    },
    now: NOW
  })
  expect(reserved.record.modelChosenBy).toBe('picker')
  const live: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    options: { model: 'opus', effort: 'high' }
  }
  const replace = (
    record: typeof live,
    options: Record<string, string>,
    modelChosenBy?: 'picker' | 'caller'
  ) =>
    replaceAgentSessionRecordOptions(record, {
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      options,
      ...(modelChosenBy ? { modelChosenBy } : {}),
      now: NOW
    }).modelChosenBy
  const picked = { ...live, modelChosenBy: 'picker' as const }
  // The start's replacement of a gone pick, or the child's report of it, stands for the same pick.
  expect(replace(picked, { model: 'sonnet', effort: 'high' })).toBe('picker')
  expect(replace(picked, { model: 'sonnet' }, 'caller')).toBe('caller')
  expect(replace(picked, { effort: 'high' })).toBeUndefined()
  // A record from before the source was kept stays a caller's; a model reported for a chat that
  // held none is nobody's pick.
  expect(replace(live, { model: 'sonnet' })).toBeUndefined()
  expect(replace({ ...picked, options: {} }, { model: 'sonnet' })).toBeUndefined()

  const reopened = await openTestAgentSessionRecordStore(directory)
  expect(reopened.getRecord(SESSION)?.modelChosenBy).toBe('picker')
})

it("reads who chose the model leniently: a value this build does not know is a caller's", async () => {
  const chat = (sessionId: string, modelChosenBy: string) => ({
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
    options: { model: 'opus' },
    modelChosenBy
  })
  await seedTestAgentSessionRecordStore(directory, {
    records: [chat('session-newer', 'remembered'), chat('session-default', 'new-chat-default')]
  })
  const store = await openTestAgentSessionRecordStore(directory)
  // A newer build's value never sets the chat aside; it reads as absent, so nothing replaces it.
  expect(store.getRecord('session-newer')).toMatchObject({ options: { model: 'opus' } })
  expect(store.getRecord('session-newer')?.modelChosenBy).toBeUndefined()
  expect(store.getRecord('session-default')?.modelChosenBy).toBe('new-chat-default')
})
