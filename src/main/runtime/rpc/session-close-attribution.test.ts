import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { SESSION_TAB_METHODS } from './methods/session-tabs'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../../observability/tracer'

// The device's bearer token rides on ctx.clientId in production; the attribution
// span must never emit it. Tests pass it through the dispatch options and assert
// it cannot reach the captured trace.
const DEVICE_TOKEN = 'secret-bearer-token-should-never-be-logged'

type CapturingSink = TracerSink & { records: unknown[] }

function capturingSink(): CapturingSink {
  const records: unknown[] = []
  return {
    records,
    push: (record) => records.push(record),
    flush: vi.fn(),
    close: vi.fn()
  }
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(
  closeMobileSessionTab = vi.fn().mockResolvedValue({ closed: true })
): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    closeMobileSessionTab
  } as unknown as OrcaRuntimeService
}

describe('session.tabs.close attribution', () => {
  let sink: CapturingSink

  beforeEach(() => {
    sink = capturingSink()
    setActiveSink(sink)
  })

  afterEach(() => {
    _resetTracerForTests()
  })

  it('records a persisted attribution span with the non-sensitive device id', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (message) => replies.push(message),
      {
        connectionId: 'conn-7',
        clientId: DEVICE_TOKEN,
        deviceId: 'device-uuid-123',
        clientKind: 'mobile'
      }
    )

    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1')
    expect(JSON.parse(replies[0]!)).toMatchObject({ ok: true })
    expect(sink.records).toEqual([
      expect.objectContaining({
        type: 'effect-span',
        name: 'session.tabs.close',
        attributes: expect.objectContaining({
          attribution: 'session-close',
          clientKind: 'mobile',
          deviceId: 'device-uuid-123',
          connectionId: 'conn-7',
          worktreeId: 'id:wt-1',
          tabId: 'tab-1'
        }),
        exit: { _tag: 'Success' }
      })
    ])
  })

  it('never lets the bearer token reach the captured trace', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      vi.fn(),
      {
        connectionId: 'conn-7',
        clientId: DEVICE_TOKEN,
        deviceId: 'device-uuid-123',
        clientKind: 'mobile'
      }
    )

    expect(sink.records).toHaveLength(1)
    expect(JSON.stringify(sink.records)).not.toContain(DEVICE_TOKEN)
  })

  it('records the real outcome when the close fails', async () => {
    const runtime = makeRuntime(vi.fn().mockRejectedValue(new Error('worktree gone')))
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-3', tabId: 'tab-3' }),
      (message) => replies.push(message),
      { connectionId: 'conn-9', deviceId: 'device-uuid-9', clientKind: 'mobile' }
    )

    // The failure surfaces to the caller unchanged...
    expect(JSON.parse(replies[0]!)).toMatchObject({ ok: false })
    // ...and the span records Failure rather than a false Success.
    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'session.tabs.close',
        attributes: expect.objectContaining({ deviceId: 'device-uuid-9' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
  })

  it('falls back to in-process sentinels for local callers without a device identity', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-2', tabId: 'tab-2' }),
      vi.fn(),
      {}
    )

    expect(sink.records).toEqual([
      expect.objectContaining({
        name: 'session.tabs.close',
        attributes: expect.objectContaining({
          clientKind: 'in-process',
          deviceId: 'in-process',
          connectionId: 'in-process',
          worktreeId: 'id:wt-2',
          tabId: 'tab-2'
        })
      })
    ])
  })
})
