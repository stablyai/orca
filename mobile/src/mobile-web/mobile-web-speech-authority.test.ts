import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import type { MobileWebSpeechRuntime } from './mobile-web-speech-runtime'

describe('MobileWebSpeechAuthority', () => {
  it('keeps PCM in the shell and finishes without cancelling a successful transcript', async () => {
    const harness = createHarness()
    harness.authority.subscribe({ requestId: 'request-1', subscriptionId: 'subscription-1' })
    harness.sendRequest.mockImplementation(async (method) => {
      if (method === 'speech.dictation.finish') {
        return success({ text: `  ${'a'.repeat(40_000)}  ` })
      }
      return success({})
    })

    await expect(harness.authority.start(harness.client)).resolves.toEqual({
      status: 'recording'
    })
    harness.microphone?.({ data: new Uint8Array([1, 2, 3, 4]) })
    await vi.waitFor(() =>
      expect(harness.sendRequest).toHaveBeenCalledWith(
        'speech.dictation.chunk',
        expect.objectContaining({ audioBase64: 'AQIDBA==', sampleRate: 16_000 })
      )
    )
    const result = await harness.authority.stop()

    expect(result).toEqual({ status: 'transcript', text: 'a'.repeat(32 * 1024) })
    expect(
      harness.sendRequest.mock.calls.filter(([method]) => method === 'speech.dictation.cancel')
    ).toHaveLength(0)
    await vi.waitFor(() =>
      expect(harness.postEvent.mock.calls).toEqual([
        ['subscription-1', 0, { status: 'recording' }],
        ['subscription-1', 1, { status: 'processing' }],
        ['subscription-1', 2, { status: 'idle' }]
      ])
    )
    expect(harness.runtime.releaseKeepAwake).toHaveBeenCalledOnce()
  })

  it('maps setup-required host failures and releases the rejected session', async () => {
    const harness = createHarness()
    harness.sendRequest.mockImplementation(async (method) =>
      method === 'speech.dictation.start' ? failure('voice_model_not_ready:model-1') : success({})
    )

    await expect(harness.authority.start(harness.client)).resolves.toEqual({
      status: 'setup-required',
      reason: 'voice_model_not_ready'
    })
    expect(harness.sendRequest).toHaveBeenCalledWith(
      'speech.dictation.cancel',
      expect.objectContaining({ dictationId: expect.any(String) })
    )
    expect(harness.runtime.toggleRecording).toHaveBeenCalledWith(false)
  })

  it('returns permission denial after the shell-owned prompt transition', async () => {
    const harness = createHarness()
    let resolvePermission: ((permission: { granted: boolean }) => void) | undefined
    harness.runtime.requestMicrophonePermission.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve
        })
    )

    const start = harness.authority.start(harness.client)
    await vi.waitFor(() => expect(resolvePermission).toBeTypeOf('function'))
    harness.authority.cancelForAppBackground()
    resolvePermission?.({ granted: false })

    await expect(start).resolves.toEqual({
      status: 'permission-denied'
    })
    expect(harness.sendRequest).not.toHaveBeenCalled()
    expect(harness.runtime.initialize).not.toHaveBeenCalled()
  })

  it('resumes a current start after the shell-owned permission prompt returns', async () => {
    const harness = createHarness()
    let resolvePermission: ((permission: { granted: boolean }) => void) | undefined
    harness.runtime.requestMicrophonePermission.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve
        })
    )
    harness.sendRequest.mockResolvedValue(success({}))

    const start = harness.authority.start(harness.client)
    await vi.waitFor(() => expect(resolvePermission).toBeTypeOf('function'))
    harness.authority.cancelForAppBackground()
    resolvePermission?.({ granted: true })

    await expect(start).resolves.toEqual({ status: 'recording' })
    expect(harness.runtime.waitForForeground).toHaveBeenCalledOnce()
    expect(harness.sendRequest).toHaveBeenCalledWith(
      'speech.dictation.start',
      expect.objectContaining({ dictationId: expect.any(String) })
    )
  })

  it('cancels recording when the native audio session is interrupted', async () => {
    const harness = createHarness()
    harness.authority.subscribe({ requestId: 'request-1', subscriptionId: 'subscription-1' })
    harness.sendRequest.mockResolvedValue(success({}))
    await harness.authority.start(harness.client)

    harness.interruption?.('began')

    await vi.waitFor(() =>
      expect(harness.sendRequest).toHaveBeenCalledWith(
        'speech.dictation.cancel',
        expect.objectContaining({ dictationId: expect.any(String) })
      )
    )
    await vi.waitFor(() =>
      expect(harness.postEvent).toHaveBeenLastCalledWith('subscription-1', 1, {
        status: 'idle',
        reason: 'interrupted'
      })
    )
  })

  it('revokes an in-flight start exactly once when the Desktop client changes', async () => {
    const harness = createHarness()
    let resolveStart: ((response: RpcResponse) => void) | undefined
    harness.sendRequest.mockImplementation((method) =>
      method === 'speech.dictation.start'
        ? new Promise<RpcResponse>((resolve) => {
            resolveStart = resolve
          })
        : Promise.resolve(success({}))
    )

    const start = harness.authority.start(harness.client)
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'))
    harness.authority.replaceClient()
    resolveStart?.(success({}))

    await expect(start).resolves.toEqual({ status: 'unavailable' })
    await vi.waitFor(() =>
      expect(
        harness.sendRequest.mock.calls.filter(([method]) => method === 'speech.dictation.cancel')
      ).toHaveLength(1)
    )
  })
})

function createHarness() {
  let microphone: ((event: { data: Uint8Array }) => void) | undefined
  let interruption: ((kind: string) => void) | undefined
  const runtime = {
    requestMicrophonePermission: vi.fn(async () => ({ granted: true })),
    waitForForeground: vi.fn(async () => true),
    initialize: vi.fn(async () => true),
    toggleRecording: vi.fn(() => true),
    tearDown: vi.fn(),
    addMicrophoneListener: vi.fn((listener) => {
      microphone = listener
      return vi.fn()
    }),
    addInterruptionListener: vi.fn((listener) => {
      interruption = listener
      return vi.fn()
    }),
    acquireKeepAwake: vi.fn(async () => {}),
    releaseKeepAwake: vi.fn(async () => {})
  } satisfies MobileWebSpeechRuntime
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = { sendRequest } as unknown as RpcClient
  const postEvent = vi.fn(async () => {})
  const postClosed = vi.fn()
  return {
    authority: new MobileWebSpeechAuthority(
      { isActive: () => true, postEvent, postClosed },
      async () => runtime
    ),
    runtime,
    client,
    sendRequest,
    postEvent,
    postClosed,
    get microphone() {
      return microphone
    },
    get interruption() {
      return interruption
    }
  }
}

function success(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function failure(message: string): RpcResponse {
  return {
    id: 'rpc',
    ok: false,
    error: { code: 'host_error', message },
    _meta: { runtimeId: 'runtime' }
  }
}
