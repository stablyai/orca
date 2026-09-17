import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { reserveRequestFor } from './structured-agent-session-attach'
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
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    expect(compact).toHaveBeenCalledTimes(1)
    const status = host
      .history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      .page.items.find((item) => item.body.kind === 'status')
    expect(status?.body).toMatchObject({
      text: 'Compaction completion is unconfirmed.',
      turnLifecycle: { state: 'running' }
    })
  })

  /** The replacement seeds from what the provider reports now, not from what the
   *  retired record happened to store — the same rule acquire and handoff apply. */
  it('adopts the reported Fast preference into the replacement record', async () => {
    adapter.readOptions = async () => ({
      models: [],
      current: { model: 'test-model', effort: 'high', fastMode: false }
    })
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(store.getRecord(result.value.replacementSessionId!)).toMatchObject({
      options: { model: 'test-model', effort: 'high', fastMode: 'false' }
    })
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
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    compact.mockResolvedValue({})
    await expect(host.conversationCommand(caller, commandParams('compact'))).resolves.toMatchObject(
      { ok: true, value: { state: 'completed' } }
    )
    finish({})
  })

  it('refuses option writes while a conversation command owns the session', async () => {
    let finish!: (value: {}) => void
    compact.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const running = host.conversationCommand(caller, commandParams('compact'))
    await vi.waitFor(() => expect(compact).toHaveBeenCalled())
    const fields = { key: 'effort', value: 'low' }

    await expect(
      host.setOption(caller, {
        envelope: {
          sessionId: HOST_TEST_SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.setOption',
            sessionId: HOST_TEST_SESSION,
            fields
          })
        },
        ...fields
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })

    await host.close(HOST_TEST_SESSION)
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    finish({})
  })

  it('does not let a stale cancellation stop an admitted compaction', async () => {
    const params = commandParams('compact')
    const turnId = `compact:${params.envelope.clientOperationId}`
    const running = host.conversationCommand(caller, params)
    const staleFence = params.envelope.expectedRuntimeFence + 1
    const cancellation = host.cancel(caller, {
      turnId,
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: staleFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: HOST_TEST_SESSION,
          fields: { turnId }
        })
      }
    })

    await expect(cancellation).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'completed' } })
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('keeps a compaction live when the provider does not accept cancellation', async () => {
    let finish!: (value: {}) => void
    compact.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    vi.mocked(adapter.cancelTurn).mockResolvedValueOnce({ cancelled: false })
    const params = commandParams('compact')
    const turnId = `compact:${params.envelope.clientOperationId}`
    const running = host.conversationCommand(caller, params)
    await vi.waitFor(() => expect(compact).toHaveBeenCalled())

    await expect(
      host.cancel(caller, {
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
    ).resolves.toMatchObject({ ok: true, value: { cancelled: false } })
    const settled = vi.fn()
    void running.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    finish({})
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'completed' } })
  })

  it('closes and reattaches while a provider compaction never settles', async () => {
    compact.mockImplementation(() => new Promise(() => {}))
    const running = host.conversationCommand(caller, commandParams('compact'))
    await vi.waitFor(() => expect(compact).toHaveBeenCalled())

    let parked: ReturnType<typeof setTimeout>
    const outcome = await Promise.race([
      host.close(HOST_TEST_SESSION).then(() => 'closed' as const),
      new Promise<'parked'>((resolve) => {
        parked = setTimeout(() => resolve('parked'), 2_000)
      })
    ])
    clearTimeout(parked!)

    expect(outcome).toBe('closed')
    expect(host.hasSession(HOST_TEST_SESSION)).toBe(false)
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })

    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.attach(caller, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    compact.mockResolvedValue({})
    await expect(host.conversationCommand(caller, commandParams('compact'))).resolves.toMatchObject(
      {
        ok: true,
        value: { state: 'completed' }
      }
    )
  })

  it('settles an out-of-lane command during whole-host teardown', async () => {
    compact.mockImplementation(() => new Promise(() => {}))
    const running = host.conversationCommand(caller, commandParams('compact'))
    await vi.waitFor(() => expect(compact).toHaveBeenCalled())

    await host.flushAllStreamedEvents()
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    expect(host.hasSession(HOST_TEST_SESSION)).toBe(false)
  })

  it('settles a compaction admitted immediately before close', async () => {
    const running = host.conversationCommand(caller, commandParams('compact'))
    const closed = host.close(HOST_TEST_SESSION)

    await expect(closed).resolves.toBeUndefined()
    await expect(running).resolves.toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    expect(host.hasSession(HOST_TEST_SESSION)).toBe(false)
  })

  it('closes and reattaches when the pre-provider event drain never settles', async () => {
    const flush = vi
      .spyOn(host, 'flushStreamedEvents')
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    const running = host.conversationCommand(caller, commandParams('compact'))
    await vi.waitFor(() => expect(flush).toHaveBeenCalled())

    await expect(host.close(HOST_TEST_SESSION)).resolves.toBeUndefined()
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    expect(compact).not.toHaveBeenCalled()

    flush.mockRestore()
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.attach(caller, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    await expect(host.conversationCommand(caller, commandParams('compact'))).resolves.toMatchObject(
      {
        ok: true,
        value: { state: 'completed' }
      }
    )
  })

  it('retires when the event drain fails before provider execution', async () => {
    vi.spyOn(host, 'flushStreamedEvents').mockRejectedValueOnce(new Error('event sink failed'))
    await expect(host.conversationCommand(caller, commandParams('compact'))).resolves.toMatchObject(
      { ok: true, value: { state: 'unknown' } }
    )
    expect(compact).not.toHaveBeenCalled()
    const status = host
      .history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      .page.items.find((item) => item.body.kind === 'status')
    expect(status?.body).toMatchObject({ turnLifecycle: { state: 'unverifiable' } })

    await expect(host.conversationCommand(caller, commandParams('clear'))).resolves.toMatchObject({
      ok: false,
      refusal: { message: 'The previous conversation operation is unconfirmed.' }
    })
  })

  it('retires when the provider settled but its final event drain fails', async () => {
    vi.spyOn(host, 'flushStreamedEvents')
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('event sink failed'))
    await expect(host.conversationCommand(caller, commandParams('compact'))).resolves.toMatchObject(
      { ok: true, value: { state: 'unknown' } }
    )
    expect(compact).toHaveBeenCalledTimes(1)
    const status = host
      .history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      .page.items.find((item) => item.body.kind === 'status')
    expect(status?.body).toMatchObject({ turnLifecycle: { state: 'unverifiable' } })
  })

  it('interrupts a command whose pre-provider event drain never settles', async () => {
    const flush = vi
      .spyOn(host, 'flushStreamedEvents')
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    const params = commandParams('compact')
    const running = host.conversationCommand(caller, params)
    await vi.waitFor(() => expect(flush).toHaveBeenCalled())
    const turnId = `compact:${params.envelope.clientOperationId}`

    await expect(
      host.cancel(caller, {
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
    ).resolves.toMatchObject({ ok: true })
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    expect(compact).not.toHaveBeenCalled()
  })

  it('abandons a blocked replacement attach and cleans up its stale late completion', async () => {
    let finishReplacement!: () => void
    const originalAcquire = vi.mocked(adapter.acquire).getMockImplementation()!
    vi.mocked(adapter.acquire).mockImplementation(async (input) => {
      if (acquisitions > 0) {
        await new Promise<void>((resolve) => {
          finishReplacement = resolve
        })
      }
      return originalAcquire(input)
    })
    const running = host.conversationCommand(caller, commandParams('clear'))
    await vi.waitFor(() => expect(finishReplacement).toBeTypeOf('function'))
    const replacementSessionId =
      store.getRecord(HOST_TEST_SESSION)?.conversationCommand?.replacementSessionId
    const close = host.close(HOST_TEST_SESSION)

    await expect(close).resolves.toBeUndefined()
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    finishReplacement()
    await vi.waitFor(() => expect(host.hasSession(replacementSessionId!)).toBe(false))
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
      command: 'clear',
      phase: 'committed',
      state: 'unknown',
      replacementSessionId: undefined
    })
  })

  it('closes a replacement attached while abandonment lifecycle publication is pending', async () => {
    const params = commandParams('clear')
    const replacementAcquire = Promise.withResolvers<void>()
    const replacementAcquireStarted = Promise.withResolvers<void>()
    const abandonmentPublication = Promise.withResolvers<void>()
    const abandonmentPersisted = Promise.withResolvers<void>()
    const replacementAttached = Promise.withResolvers<void>()
    const originalAcquire = vi.mocked(adapter.acquire).getMockImplementation()!
    vi.mocked(adapter.acquire).mockImplementation(async (input) => {
      if (acquisitions > 0) {
        replacementAcquireStarted.resolve()
        await replacementAcquire.promise
      }
      return originalAcquire(input)
    })
    const persistOutcome = store.recordOperationOutcome.bind(store)
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      await persistOutcome(input)
      if (
        input.operationId === params.envelope.clientOperationId &&
        input.outcome.status === 'succeeded' &&
        input.outcome.conversationCommand?.state === 'unknown'
      ) {
        abandonmentPersisted.resolve()
        await abandonmentPublication.promise
      }
    })
    const attachReplacement = host.attach.bind(host)
    vi.spyOn(host, 'attach').mockImplementation(async (attachCaller, input) => {
      const result = await attachReplacement(attachCaller, input)
      if (input.envelope.sessionId !== HOST_TEST_SESSION) {
        replacementAttached.resolve()
      }
      return result
    })

    const running = host.conversationCommand(caller, params)
    await replacementAcquireStarted.promise
    const replacementSessionId =
      store.getRecord(HOST_TEST_SESSION)?.conversationCommand?.replacementSessionId
    const close = host.close(HOST_TEST_SESSION)
    await abandonmentPersisted.promise

    replacementAcquire.resolve()
    await replacementAttached.promise
    await vi.waitFor(() => expect(host.hasSession(replacementSessionId!)).toBe(false))

    abandonmentPublication.resolve()
    await expect(close).resolves.toBeUndefined()
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
  })

  it('does not publish terminal success before its durable command commit', async () => {
    const persist = store.setConversationCommand.bind(store)
    let failed = false
    vi.spyOn(store, 'setConversationCommand').mockImplementation(async (...input) => {
      if (!failed && input[2].phase === 'committed') {
        failed = true
        throw new Error('disk full')
      }
      return persist(...input)
    })
    const params = commandParams('compact')
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    const status = host
      .history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      .page.items.find((item) => item.body.kind === 'status')
    expect(status?.body).toMatchObject({ turnLifecycle: { state: 'unverifiable' } })
    expect(status?.body).not.toMatchObject({ turnLifecycle: { state: 'completed' } })
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
      phase: 'prepared',
      state: 'unknown'
    })
  })

  it('does not publish terminal success before its durable operation outcome', async () => {
    const params = commandParams('compact')
    const persist = store.recordOperationOutcome.bind(store)
    let failed = false
    vi.spyOn(store, 'recordOperationOutcome').mockImplementation(async (input) => {
      if (
        !failed &&
        input.operationId === params.envelope.clientOperationId &&
        input.outcome.status === 'succeeded'
      ) {
        failed = true
        throw new Error('ledger write failed')
      }
      return persist(input)
    })

    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    const status = host
      .history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      .page.items.find((item) => item.body.kind === 'status')
    expect(status?.body).toMatchObject({ turnLifecycle: { state: 'unverifiable' } })
    expect(status?.body).not.toMatchObject({ turnLifecycle: { state: 'completed' } })
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
      phase: 'committed',
      state: 'completed'
    })
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'completed' }
    })
  })

  it('settles clear from the durable replacement when its attach reply is lost', async () => {
    const originalAttach = host.attach.bind(host)
    vi.spyOn(host, 'attach').mockImplementationOnce(async (...args) => {
      const attached = await originalAttach(...args)
      if (!attached.ok) {
        return attached
      }
      throw new Error('response lost after replacement attach')
    })
    const interrupted = commandParams('clear')
    const result = await host.conversationCommand(caller, interrupted)
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed' }
    })
    const replacementSessionId =
      store.getRecord(HOST_TEST_SESSION)?.conversationCommand?.replacementSessionId
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
      phase: 'committed',
      operationId: interrupted.envelope.clientOperationId,
      replacementSessionId
    })
    expect(await host.conversationCommand(caller, interrupted)).toMatchObject({
      ok: true,
      replayed: true,
      value: { replacementSessionId }
    })
  })

  it('does not commit clear when replacement attachment stops at a reservation', async () => {
    vi.spyOn(host, 'attach').mockImplementationOnce(async (replacementCaller, params) => {
      await store.reserveOwner(
        reserveRequestFor({
          sessionId: params.envelope.sessionId,
          params,
          authority: {
            spawnToken: 'reserved-replacement',
            claimKeyId: 'key',
            handoffOperationId: params.envelope.clientOperationId,
            probe: { outcome: 'reservation-unused' }
          },
          callerKey: replacementCaller.callerKey,
          fingerprint: params.envelope.payloadFingerprint,
          now: HOST_TEST_NOW
        })
      )
      throw new Error('replacement owner was not proved')
    })

    await expect(host.conversationCommand(caller, commandParams('clear'))).resolves.toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    const command = store.getRecord(HOST_TEST_SESSION)?.conversationCommand
    expect(command).toMatchObject({ command: 'clear', phase: 'prepared', state: 'unknown' })
    expect(store.getRecord(command!.replacementSessionId!)?.lease.claimStatus).toBe('reserved')
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  })

  it('retires a failed clear that has no provider callback to settle it later', async () => {
    vi.spyOn(host, 'attach').mockRejectedValueOnce(new Error('x'.repeat(5_000)))
    const result = await host.conversationCommand(caller, commandParams('clear'))
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    if (!result.ok) {
      throw new Error('clear was refused')
    }
    expect(result.value.error).toHaveLength(4_096)
    const status = host
      .history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
      .page.items.find((item) => item.body.kind === 'status')
    expect(status?.body).toMatchObject({ turnLifecycle: { state: 'unverifiable' } })

    await expect(host.conversationCommand(caller, commandParams('compact'))).resolves.toMatchObject(
      {
        ok: false,
        refusal: { message: 'The previous conversation operation is unconfirmed.' }
      }
    )
  })

  it('recovers an older clear id after a newer client prepared the same replacement', async () => {
    const original = commandParams('clear')
    const fingerprint = original.envelope.payloadFingerprint
    const admitted = await store.admitMutationOperation({
      callerKey: caller.callerKey,
      envelope: original.envelope,
      hostFingerprint: fingerprint,
      now: HOST_TEST_NOW
    })
    expect(admitted?.admission.decision).toBe('admit')
    await store.recordOperationOutcome({
      callerKey: caller.callerKey,
      operationId: original.envelope.clientOperationId,
      outcome: { status: 'unknown' }
    })
    const replacementSessionId = `clear-${createHash('sha256')
      .update(
        JSON.stringify([HOST_TEST_SESSION, caller.callerKey, original.envelope.clientOperationId])
      )
      .digest('hex')
      .slice(0, 40)}`
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    await store.setConversationCommand(HOST_TEST_SESSION, fence, {
      command: 'clear',
      runtimeFence: fence,
      operationId: hostTestOperationId(),
      callerKey: 'mobile',
      phase: 'prepared',
      state: 'unknown',
      replacementSessionId
    })

    await expect(host.conversationCommand(caller, original)).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId }
    })
    expect(acquisitions).toBe(2)
  })

  it('repairs an unknown receipt when the provider completes late', async () => {
    compact.mockRejectedValue(new Error('connection lost'))
    const params = commandParams('compact')
    await expect(host.conversationCommand(caller, params)).resolves.toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    await compact.mock.calls[0]![0].onLateResult?.({})
    expect(await host.conversationCommand(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { state: 'completed' }
    })
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale late completion after close and a new generation', async () => {
    compact.mockRejectedValueOnce(new Error('connection lost'))
    const oldParams = commandParams('compact')
    await expect(host.conversationCommand(caller, oldParams)).resolves.toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
    const late = compact.mock.calls[0]![0].onLateResult!

    await host.close(HOST_TEST_SESSION)
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.attach(caller, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    compact.mockResolvedValue({})
    const current = commandParams('compact')
    await expect(host.conversationCommand(caller, current)).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed' }
    })

    await late({ error: 'stale failure' })
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand).toMatchObject({
      operationId: current.envelope.clientOperationId,
      state: 'completed'
    })
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationCommand?.error).toBeUndefined()
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
    await expect(host.conversationCommand(caller, params)).resolves.toMatchObject({
      ok: true,
      value: { state: 'unknown' }
    })
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
