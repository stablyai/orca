import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-claude' }
const CLAUDE_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
const DEFAULT_MODEL = 'sonnet'
const PICKED_MODEL = 'opus'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let activeModel: string
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let order: string[]
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
  setOption = vi.fn(async ({ key, value }) => {
    order.push(`${key}=${value}`)
    if (key === 'model') {
      activeModel = value
    }
    return { [key]: value }
  })
  dispatch = vi.fn(async () => {
    order.push('dispatch')
    return { state: 'admitted' as const }
  })
  acquire = vi.fn(async ({ fence, spawnToken, options }) => {
    activeModel = options?.model ?? DEFAULT_MODEL
    return {
      process: { hostId: 'local', pid: 4200, processStartTimeMs: NOW, spawnToken },
      acquisitionGeneration: 'generation-1',
      link: {
        linkId: `claude-native-${fence}`,
        handle: claudeProviderHandle(CLAUDE_SESSION, 'native-leaf'),
        origin: acquire.mock.calls.length === 1 ? 'created' : 'resumed',
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  return {
    acquire,
    dispatch,
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption,
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
  order = []
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(root),
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
  it('takes a pick made while the agent starts as intent and applies it, model first, before the first send', async () => {
    const pick = (key: string, value: string) =>
      host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', { key, value }),
        key,
        value
      })
    // Answered at once: nothing waits on a provider still starting.
    expect(await pick('effort', 'high')).toMatchObject({ ok: true })
    expect(await pick('model', PICKED_MODEL)).toMatchObject({ ok: true })
    expect(setOption).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.options).toEqual({ effort: 'high', model: PICKED_MODEL })

    const body = hostTestMessage('hello')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true })
    expect(dispatch).not.toHaveBeenCalled()

    // The start's own report was read before the picks, so it is out of date.
    await host.handleAdapterEvent({
      type: 'started',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: 'generation-1',
      reportedOptions: { model: DEFAULT_MODEL },
      restoreSkippedOptions: [],
      optionRevision: 0
    })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(order).toEqual([`model=${PICKED_MODEL}`, 'effort=high', 'dispatch'])
    expect(activeModel).toBe(PICKED_MODEL)
    await host.flushAllStreamedEvents()
    expect(store.getRecord(SESSION)?.options).toEqual({ effort: 'high', model: PICKED_MODEL })
  })
})
