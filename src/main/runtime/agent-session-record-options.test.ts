import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
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

it('persists resumed provider options atomically with owner proof', async () => {
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
      handle: { provider: 'codex', threadId: 'thread-options' },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW,
    ...(options ? { options } : {})
  })

  const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  expect(reopened.getRecord(SESSION)?.options).toEqual({ model: 'gpt-tui', effort: 'low' })
})
