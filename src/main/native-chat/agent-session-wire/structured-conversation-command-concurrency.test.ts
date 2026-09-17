import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

const compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let store: ReturnType<typeof hostTestState>['store']

function commandParams(command: AgentSessionConversationCommand) {
  return {
    command,
    envelope: envelope('agentSession.conversationCommand', { command })
  }
}

beforeEach(async () => {
  const state = hostTestState()
  ;({ host, dispatch, store } = state)
  const acquire = state.acquire.getMockImplementation()
  if (!acquire) {
    throw new Error('host harness has no acquisition implementation')
  }
  state.acquire.mockImplementation(async (input) => ({
    ...(await acquire(input)),
    acquisitionGeneration: 'generation-1'
  }))
  compact.mockReset().mockResolvedValue({})
  host.deps.adapter.compact = compact
  await attach()
})

describe('host conversation command concurrency', () => {
  it('replays an accepted send while a later conversation command is running', async () => {
    const body = hostTestMessage('send exactly once')
    const params = { body, envelope: envelope('agentSession.send', { body }) }
    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })

    const completion = Promise.withResolvers<Record<string, never>>()
    compact.mockReturnValueOnce(completion.promise)
    const running = host.conversationCommand(CALLER, commandParams('compact'))
    await vi.waitFor(() => expect(compact).toHaveBeenCalled())

    await expect(host.send(CALLER, params)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    const newBody = hostTestMessage('must wait')
    await expect(
      host.send(CALLER, {
        body: newBody,
        envelope: envelope('agentSession.send', { body: newBody })
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)

    completion.resolve({})
    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'completed' } })
  })

  it('does not coalesce a mismatched duplicate with the active command', async () => {
    const completion = Promise.withResolvers<Record<string, never>>()
    compact.mockReturnValueOnce(completion.promise)
    const params = commandParams('compact')
    const running = host.conversationCommand(CALLER, params)
    await vi.waitFor(() => expect(compact).toHaveBeenCalled())

    const mismatched = host.conversationCommand(CALLER, {
      ...params,
      envelope: { ...params.envelope, payloadFingerprint: '0'.repeat(64) }
    })
    completion.resolve({})

    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'completed' } })
    await expect(mismatched).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('retires an old command after provider recovery advances the session generation', async () => {
    await host.hold(HOST_TEST_SESSION, 'conversation-surface')
    let rejectFlush!: (error: Error) => void
    const flush = vi.spyOn(host, 'flushStreamedEvents').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFlush = reject
        })
    )
    const params = commandParams('compact')
    const running = host.conversationCommand(CALLER, params)
    await vi.waitFor(() => expect(rejectFlush).toBeTypeOf('function'))
    const fence = store.getRecord(params.envelope.sessionId)!.lease.runtimeFence

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: params.envelope.sessionId,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence,
      acquisitionGeneration: 'generation-1'
    })
    expect(store.getRecord(params.envelope.sessionId)?.lease.runtimeFence).toBeGreaterThan(fence)
    rejectFlush(new Error('old event sink failed'))

    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    flush.mockRestore()
    await expect(host.conversationCommand(CALLER, commandParams('compact'))).resolves.toMatchObject(
      { ok: true, value: { state: 'completed' } }
    )
  })

  it('does not start provider work after recovery advances during event flushing', async () => {
    await host.hold(HOST_TEST_SESSION, 'conversation-surface')
    const flush = Promise.withResolvers<void>()
    const flushing = Promise.withResolvers<void>()
    vi.spyOn(host, 'flushStreamedEvents').mockImplementationOnce(() => {
      flushing.resolve()
      return flush.promise
    })
    const running = host.conversationCommand(CALLER, commandParams('compact'))
    await flushing.promise
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: HOST_TEST_SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence,
      acquisitionGeneration: 'generation-1'
    })
    flush.resolve()

    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    expect(compact).not.toHaveBeenCalled()
  })

  it('does not start provider work after the durable lease advances ahead of publication', async () => {
    const flush = Promise.withResolvers<void>()
    const flushing = Promise.withResolvers<void>()
    vi.spyOn(host, 'flushStreamedEvents').mockImplementationOnce(() => {
      flushing.resolve()
      return flush.promise
    })
    const readRecord = store.getRecord.bind(store)
    let leaseAdvanced = false
    vi.spyOn(store, 'getRecord').mockImplementation((sessionId) => {
      const record = readRecord(sessionId)
      return leaseAdvanced && record && sessionId === HOST_TEST_SESSION
        ? {
            ...record,
            lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 }
          }
        : record
    })
    const running = host.conversationCommand(CALLER, commandParams('compact'))
    await flushing.promise

    leaseAdvanced = true
    flush.resolve()

    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    expect(compact).not.toHaveBeenCalled()
  })

  it('retires a provider completion that arrives after recovery advances the generation', async () => {
    await host.hold(HOST_TEST_SESSION, 'conversation-surface')
    const flush = vi.spyOn(host, 'flushStreamedEvents')
    const completion = Promise.withResolvers<Record<string, never>>()
    compact.mockReturnValueOnce(completion.promise)
    const running = host.conversationCommand(CALLER, commandParams('compact'))
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce())
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: HOST_TEST_SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence,
      acquisitionGeneration: 'generation-1'
    })
    expect(store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence).toBeGreaterThan(fence)
    const flushesBeforeCompletion = flush.mock.calls.length
    completion.resolve({})

    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    expect(flush).toHaveBeenCalledTimes(flushesBeforeCompletion)
    await expect(host.conversationCommand(CALLER, commandParams('compact'))).resolves.toMatchObject(
      { ok: true, value: { state: 'completed' } }
    )
  })

  it('retires a clear replacement that finishes after recovery advances the generation', async () => {
    await host.hold(HOST_TEST_SESSION, 'conversation-surface')
    const originalAttach = host.attach.bind(host)
    const replacementStarted = Promise.withResolvers<void>()
    const releaseReplacement = Promise.withResolvers<void>()
    vi.spyOn(host, 'attach').mockImplementation(async (caller, params) => {
      if (params.envelope.sessionId.startsWith('clear-')) {
        replacementStarted.resolve()
        await releaseReplacement.promise
      }
      return originalAttach(caller, params)
    })
    const params = commandParams('clear')
    const running = host.conversationCommand(CALLER, params)
    await replacementStarted.promise
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: HOST_TEST_SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence,
      acquisitionGeneration: 'generation-1'
    })
    expect(store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence).toBeGreaterThan(fence)
    releaseReplacement.resolve()

    await expect(running).resolves.toMatchObject({ ok: true, value: { state: 'unknown' } })
    const recoveredFence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    await expect(
      host.conversationCommand(CALLER, {
        ...params,
        envelope: { ...params.envelope, expectedRuntimeFence: recoveredFence }
      })
    ).resolves.toMatchObject({ ok: true, value: { state: 'completed' } })
  })
})
