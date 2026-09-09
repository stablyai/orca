import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const caller = { callerKey: 'desktop' }
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let adapter: StructuredAgentSessionAdapter
const compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
let acquisitions = 0

function commandParams(command: AgentSessionConversationCommand) {
  return {
    command,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: HOST_TEST_SESSION,
        fields: { command }
      })
    }
  }
}

beforeEach(async () => {
  resetHostTestOperationIds()
  acquisitions = 0
  compact.mockReset().mockResolvedValue({})
  directory = await mkdtemp(join(tmpdir(), 'orca-conversation-command-'))
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  adapter = {
    supportsLocation: (location) =>
      location.executionHostId === 'local' && location.wslDistro === null,
    acquire: vi.fn(async (input) => {
      acquisitions++
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquisitions,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `link-${acquisitions}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: input.fence > 1 ? ('resumed' as const) : ('created' as const),
          handle: {
            provider: 'codex' as const,
            threadId:
              input.identity.providerHandle.kind === 'codex'
                ? input.identity.providerHandle.threadId
                : `00000000-0000-4000-8000-${String(acquisitions).padStart(12, '0')}`
          }
        }
      }
    }),
    dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    compact,
    releaseAcquisition: async () => true,
    closeSession: async () => true,
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
  }
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: directory,
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    mintSpawnToken: () => `spawn-${acquisitions}`
  })
  expect(
    await host.attach(caller, hostTestAttachParams(null, { options: { effort: 'low' } }))
  ).toMatchObject({ ok: true })
  await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

describe('host conversation commands', () => {
  it('compacts once without an ordinary message submission and replays its receipt', async () => {
    const params = commandParams('compact')
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      value: { state: 'completed' }
    })
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true
    })
    expect(compact).toHaveBeenCalledTimes(1)
    expect(adapter.dispatch).not.toHaveBeenCalled()
    const history = host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    expect(history.page.submissions).toEqual([])
    expect(
      history.page.items.some(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle?.state === 'running'
      )
    ).toBe(false)
  })

  it('reports provider compaction failure without a stuck lifecycle', async () => {
    compact.mockResolvedValue({ error: 'Not enough messages to compact.' })
    expect(await host.conversationCommand(caller, commandParams('compact'))).toMatchObject({
      ok: true,
      value: { state: 'completed', error: 'Not enough messages to compact.' }
    })
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand?.state).toBe('completed')
  })

  it('keeps an unknown compaction from being executed again', async () => {
    compact.mockRejectedValue(new Error('connection lost'))
    const params = commandParams('compact')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('connection lost')
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('clears with a fresh record and effective options, retaining old history and idempotent mapping', async () => {
    const before = store.getRecord(HOST_TEST_SESSION)!
    const params = commandParams('clear')
    const result = await host.conversationCommand(caller, params)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const nextId = result.value.replacementSessionId!
    expect(nextId).not.toBe(HOST_TEST_SESSION)
    expect(store.getRecord(nextId)).toMatchObject({
      location: before.location,
      accountHome: before.accountHome,
      options: { model: 'test-model', effort: 'high' }
    })
    expect(store.getRecord(HOST_TEST_SESSION)).not.toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([nextId])
    expect(host.history({ sessionId: nextId, direction: 'tail' }).page.items).toEqual([])
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { replacementSessionId: nextId }
    })
    expect(acquisitions).toBe(2)
    const body = hostTestMessage('late send')
    expect(
      await host.send(caller, {
        body,
        envelope: {
          ...params.envelope,
          clientOperationId: hostTestOperationId(),
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: HOST_TEST_SESSION,
            fields: { body }
          })
        }
      })
    ).toMatchObject({ ok: false })
    expect(adapter.dispatch).not.toHaveBeenCalled()
  })

  it('leaves the source usable when replacement creation is definitely refused', async () => {
    vi.spyOn(host, 'attach').mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'Unavailable' }
    })
    expect(await host.conversationCommand(caller, commandParams('clear'))).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: undefined, error: expect.any(String) }
    })
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect(acquisitions).toBe(1)
    expect(await host.conversationCommand(caller, commandParams('compact'))).toMatchObject({
      ok: true
    })
  })

  it('rejects stale fences before provider execution', async () => {
    const params = commandParams('compact')
    params.envelope.expectedRuntimeFence++
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    expect(compact).not.toHaveBeenCalled()
  })
  it('allows cancellation while compaction is awaiting completion and refuses a second client', async () => {
    let finish!: (value: {}) => void
    compact.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const params = commandParams('compact')
    const running = host.conversationCommand(caller, params)
    await vi.waitFor(() => expect(compact).toHaveBeenCalled())
    expect(
      await host.conversationCommand({ callerKey: 'mobile' }, commandParams('clear'))
    ).toMatchObject({ ok: false })
    const turnId = `compact:${params.envelope.clientOperationId}`
    const cancel = await host.cancel(caller, {
      turnId,
      envelope: {
        ...params.envelope,
        clientOperationId: hostTestOperationId(),
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: HOST_TEST_SESSION,
          fields: { turnId }
        })
      }
    })
    expect(cancel).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(adapter.cancelTurn).toHaveBeenCalled()
    finish({})
    await running
  })

  it('reconstructs a committed replacement after the ledger settlement is lost', async () => {
    const persist = store.recordOperationOutcome.bind(store)
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (input.outcome.status === 'succeeded' && input.outcome.conversationCommand) {
        throw new Error('crash')
      }
      return persist(input)
    })
    const params = commandParams('clear')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow('crash')
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'completed' }
    })
    expect(acquisitions).toBe(2)
  })

  it('repairs an unknown receipt when the provider completes late', async () => {
    compact.mockRejectedValue(new Error('connection lost'))
    const params = commandParams('compact')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow()
    await compact.mock.calls[0]![0].onLateResult?.({})
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'completed' }
    })
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('keeps explicitly revealed history and closed replacement tabs out of automatic restoration', async () => {
    const result = await host.conversationCommand(caller, commandParams('clear'))
    if (!result.ok) {
      throw new Error('clear failed')
    }
    expect(host.conversationReplacements()).toHaveLength(1)
    await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
    expect(host.conversationReplacements()).toEqual([])
    await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
    await host.setSessionTabVisibility(result.value.replacementSessionId!, false)
    expect(host.conversationReplacements()).toEqual([])
  })
  it('keeps the old compact outcome unknown but restores usability after verified reacquisition', async () => {
    compact.mockRejectedValue(new Error('lost response'))
    const params = commandParams('compact')
    await expect(host.conversationCommand(caller, params)).rejects.toThrow()
    await host.close(HOST_TEST_SESSION)
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.attach(caller, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
      phase: 'committed',
      state: 'unknown'
    })
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'unknown' }
    })
    compact.mockResolvedValue({})
    expect(await host.conversationCommand(caller, commandParams('compact'))).toMatchObject({
      ok: true,
      value: { state: 'completed' }
    })
  })
})
