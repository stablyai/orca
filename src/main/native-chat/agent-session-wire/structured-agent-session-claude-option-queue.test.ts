import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-claude' }
const CLAUDE_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
const DEFAULT_MODEL = 'sonnet'
const PICKED_MODEL = 'opus'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let activeModel: string
let optionWritable: Promise<void>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function adapter(): StructuredAgentSessionAdapter {
  setOption = vi.fn(async ({ value }) => {
    activeModel = value
    return { model: value }
  })
  acquire = vi.fn(async ({ fence, spawnToken, options }) => {
    activeModel = options?.model ?? DEFAULT_MODEL
    return {
      process: { hostId: 'local', pid: 4200, processStartTimeMs: NOW, spawnToken },
      link: {
        linkId: `claude-native-${fence}`,
        handle: { provider: 'claude', sessionId: CLAUDE_SESSION, leafUuid: 'native-leaf' },
        origin: acquire.mock.calls.length === 1 ? 'created' : 'resumed',
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  return {
    acquire,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption,
    awaitOptionWritable: () => optionWritable,
    readOptions: vi.fn(async () => ({ current: { model: activeModel }, models: [] })),
    closeSession: vi.fn(async () => {
      activeModel = DEFAULT_MODEL
      return true
    })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-options-'))
  resetHostTestOperationIds()
  activeModel = DEFAULT_MODEL
  optionWritable = Promise.resolve()
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-claude',
    now: () => NOW
  })
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'claude',
        agent: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
        providerHandle: { kind: 'claude', sessionId: CLAUDE_SESSION, leafUuid: 'native-leaf' }
      })
    )
  ).toMatchObject({ ok: true })
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('Claude structured session options', () => {
  it('queues a pick made while the provider starts only once it can take it', async () => {
    let land = (): void => {}
    optionWritable = new Promise((resolve) => {
      land = resolve
    })
    const fields = { key: 'model', value: PICKED_MODEL }
    const picked = host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(setOption).not.toHaveBeenCalled()

    land()
    expect(await picked).toMatchObject({ ok: true, value: { options: { model: PICKED_MODEL } } })
    expect(store.getRecord(SESSION)?.options).toEqual({ model: PICKED_MODEL })
  })
})
