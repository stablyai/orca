// src/renderer/src/runtime/runtime-rpc-client-stream.test.ts
// subscribeRuntimeStreamChannel — split out of runtime-rpc-client.test.ts
// (max-lines budget: test files cap at 800 lines, this file's parent test
// suite had grown to 979). FE-TASK-EVM-002's own describe block, unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError, subscribeRuntimeStreamChannel } from './runtime-rpc-client'

const runtimeCall = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()

beforeEach(() => {
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentCall, subscribe: runtimeEnvironmentSubscribe }
    }
  })
})

// FE-TASK-EVM-002: generic streaming client for a StreamChannelHandler
// channel (registry.go) — e.g. ephemeralVm.provision once TASK-BE-EVM-005
// ships. These tests drive a MOCK window.api.runtimeEnvironments.subscribe;
// they don't need a real backend-go server. See "Integration test thật với
// ephemeralVm.provision" below for the one case that does.
describe('subscribeRuntimeStreamChannel', () => {
  type MockSubscriptionCallbacks = {
    onResponse: (response: unknown) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  }

  // Why: mirrors window.api.runtimeEnvironments.subscribe's real contract
  // (see api-types.ts) closely enough to drive subscribeRuntimeStreamChannel
  // without a real WebRuntimeClient/WebSessionClient connection — captures
  // the callbacks so a test can push further simulated frames after the
  // subscribe() call itself has resolved.
  function mockSubscription(): {
    unsubscribeSpy: ReturnType<typeof vi.fn>
    emit: (response: unknown) => void
    emitError: (error: { code: string; message: string }) => void
  } {
    let callbacks: MockSubscriptionCallbacks | null = null
    const unsubscribeSpy = vi.fn()
    runtimeEnvironmentSubscribe.mockImplementation(
      (_args: unknown, cb: MockSubscriptionCallbacks) => {
        callbacks = cb
        return Promise.resolve({ unsubscribe: unsubscribeSpy, sendBinary: vi.fn() })
      }
    )
    return {
      unsubscribeSpy,
      emit: (response) => callbacks?.onResponse(response),
      emitError: (error) => callbacks?.onError?.(error)
    }
  }

  const ENV_TARGET = { kind: 'environment' as const, environmentId: 'env-1' }

  it('resolves ack from the first response', async () => {
    const { emit } = mockSubscription()
    const onEvent = vi.fn()

    const pending = subscribeRuntimeStreamChannel<{ provisionId: string }, unknown>(
      ENV_TARGET,
      'ephemeralVm.provision',
      { recipeId: 'r1', runtimeId: 'rt1', connectionId: 'c1' },
      onEvent
    )
    emit({ id: 'req-1', ok: true, result: { provisionId: 'prov-1' }, _meta: { runtimeId: 'rt1' } })

    const { ack } = await pending
    expect(ack).toEqual({ provisionId: 'prov-1' })
    expect(onEvent).not.toHaveBeenCalled()
    expect(runtimeEnvironmentSubscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'ephemeralVm.provision',
        params: { recipeId: 'r1', runtimeId: 'rt1', connectionId: 'c1' }
      },
      expect.any(Object)
    )
  })

  it('routes each push frame after the ack to onEvent, in order', async () => {
    const { emit } = mockSubscription()
    const onEvent = vi.fn()

    const pending = subscribeRuntimeStreamChannel<{ provisionId: string }, { line: string }>(
      ENV_TARGET,
      'ephemeralVm.provision',
      {},
      onEvent
    )
    emit({ id: 'req-1', ok: true, result: { provisionId: 'prov-1' }, _meta: { runtimeId: 'rt1' } })
    await pending

    emit({ id: 'req-1', ok: true, result: { line: 'l1' }, _meta: { runtimeId: 'rt1' } })
    emit({ id: 'req-1', ok: true, result: { line: 'l2' }, _meta: { runtimeId: 'rt1' } })

    expect(onEvent).toHaveBeenNthCalledWith(1, { line: 'l1' })
    expect(onEvent).toHaveBeenNthCalledWith(2, { line: 'l2' })
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('stops delivering events after unsubscribe() is called', async () => {
    const { emit, unsubscribeSpy } = mockSubscription()
    const onEvent = vi.fn()

    const pending = subscribeRuntimeStreamChannel<{ provisionId: string }, { line: string }>(
      ENV_TARGET,
      'ephemeralVm.provision',
      {},
      onEvent
    )
    emit({ id: 'req-1', ok: true, result: { provisionId: 'prov-1' }, _meta: { runtimeId: 'rt1' } })
    const { unsubscribe } = await pending

    emit({
      id: 'req-1',
      ok: true,
      result: { line: 'before-unsubscribe' },
      _meta: { runtimeId: 'rt1' }
    })
    unsubscribe()
    emit({
      id: 'req-1',
      ok: true,
      result: { line: 'after-unsubscribe' },
      _meta: { runtimeId: 'rt1' }
    })

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ line: 'before-unsubscribe' })
  })

  it('rejects when the ack response itself is a failure', async () => {
    const { emit } = mockSubscription()
    const onEvent = vi.fn()

    const pending = subscribeRuntimeStreamChannel(ENV_TARGET, 'ephemeralVm.provision', {}, onEvent)
    emit({
      id: 'req-1',
      ok: false,
      error: { code: 'invalid_argument', message: 'unknown recipeId' },
      _meta: { runtimeId: null }
    })

    await expect(pending).rejects.toBeInstanceOf(RuntimeRpcCallError)
    await expect(pending).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('is not applicable to target.kind === "local" (desktop keeps its own window.api path)', async () => {
    const onEvent = vi.fn()
    await expect(
      subscribeRuntimeStreamChannel({ kind: 'local' }, 'ephemeralVm.provision', {}, onEvent)
    ).rejects.toThrow(/target\.kind === 'local'/)
    expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
  })

  // TASK-BE-EVM-005 has shipped: channels_ephemeral_vm.go's
  // registerEphemeralVmProvisionChannel now calls r.RegisterStreamChannel(
  // "ephemeralVm.provision", ...). Auditing the frontend test suite first
  // (per this task's instructions) found NO precedent anywhere of a test
  // that spins up or connects to a real backend-go process/transport for a
  // StreamChannelHandler channel — even the more rigorous
  // remote-runtime-client.test.ts / web-runtime-client.test.ts cases go only
  // as far as a real `ws` TCP loopback against a hand-written TS server
  // double, never the actual Go binary. There is no established
  // cross-process integration harness to extend here.
  //
  // This is instead the fullest test possible within that real constraint:
  // it drives subscribeRuntimeStreamChannel's real, unmocked implementation
  // against the CONFIRMED wire shapes backend-go actually emits for this
  // exact channel (read from source, not the old planning-doc guess):
  //  - ack: ephemeralVmProvisionAckView's JSON tag, {"provisionId": "..."}
  //    (channels_ephemeral_vm.go:303-305) — no `streaming` flag, matching
  //    handleInvoke's writeDialectResult.
  //  - push events: pipePushForDialect (push_bridge.go:65-96) re-encodes
  //    each PushEvent as a SessionClientResultMessage{id, ok:true,
  //    streaming:true, result: pushEventResult(ev)}; pushEventResult
  //    (push_bridge.go:106-113) unwraps a single-arg PushEvent.Args to that
  //    value directly, which here is toEphemeralVmProvisionEventView's map:
  //    {provisionId, type, chunk} for stdout/stderr, {provisionId, type,
  //    result: toEphemeralVmProvisionResultView(...)} for "result"
  //    (channels_ephemeral_vm.go:396,405-427).
  it('integration: real subscribeRuntimeStreamChannel against the confirmed ephemeralVm.provision/onProvisionEvent wire shape', async () => {
    const { emit } = mockSubscription()
    const events: unknown[] = []

    const pending = subscribeRuntimeStreamChannel<
      { provisionId: string },
      { provisionId: string; type: string; chunk?: string; result?: unknown; error?: string }
    >(
      ENV_TARGET,
      'ephemeralVm.provision',
      { connectionId: 'conn-1', recipeId: 'recipe-1', runtimeId: 'rt-1' },
      (event) => events.push(event)
    )

    // Real ack — ephemeralVmProvisionAckView, no `streaming` flag.
    emit({
      id: 'req-1',
      ok: true,
      result: { provisionId: 'prov-xyz' },
      _meta: { runtimeId: 'rt-1' }
    })
    const { ack, unsubscribe } = await pending
    expect(ack).toEqual({ provisionId: 'prov-xyz' })
    expect(events).toEqual([])

    // Real push frames — SessionClientResultMessage{streaming:true, result: toEphemeralVmProvisionEventView(...)}.
    emit({
      id: 'req-1',
      ok: true,
      streaming: true,
      result: { provisionId: 'prov-xyz', type: 'stdout', chunk: 'pulling image...' },
      _meta: { runtimeId: 'rt-1' }
    })
    emit({
      id: 'req-1',
      ok: true,
      streaming: true,
      result: { provisionId: 'prov-xyz', type: 'stderr', chunk: 'warning: slow network' },
      _meta: { runtimeId: 'rt-1' }
    })
    emit({
      id: 'req-1',
      ok: true,
      streaming: true,
      result: {
        provisionId: 'prov-xyz',
        type: 'result',
        result: { type: 'orca-server', projectRoot: '/vm/repo', pairingCode: 'abc-123' }
      },
      _meta: { runtimeId: 'rt-1' }
    })

    expect(events).toEqual([
      { provisionId: 'prov-xyz', type: 'stdout', chunk: 'pulling image...' },
      { provisionId: 'prov-xyz', type: 'stderr', chunk: 'warning: slow network' },
      {
        provisionId: 'prov-xyz',
        type: 'result',
        result: { type: 'orca-server', projectRoot: '/vm/repo', pairingCode: 'abc-123' }
      }
    ])

    unsubscribe()
    emit({
      id: 'req-1',
      ok: true,
      streaming: true,
      result: { provisionId: 'prov-xyz', type: 'stdout', chunk: 'after unsubscribe' },
      _meta: { runtimeId: 'rt-1' }
    })
    expect(events).toHaveLength(3)
  })
})
