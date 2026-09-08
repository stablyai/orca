import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { RuntimeRpcFailure } from '../../../../shared/runtime-rpc-envelope'
import {
  createConnectivitySlice,
  installConnectivityPolling,
  isConnectivityLikeRpcError,
  type ConnectivitySlice
} from './connectivity-status'
import { callRuntimeRpc, RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'

vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: vi.fn()
}))

const callRuntimeRpcMock = vi.mocked(callRuntimeRpc)

const LOCAL_TARGET = { kind: 'local' } as const

function createSliceStore() {
  return create<ConnectivitySlice>()((...a) => ({
    ...createConnectivitySlice(...(a as unknown as Parameters<typeof createConnectivitySlice>))
  }))
}

function rpcFailure(code: string, message: string): RuntimeRpcCallError {
  const response: RuntimeRpcFailure = { id: '1', ok: false, error: { code, message } }
  return new RuntimeRpcCallError(response)
}

describe('pollConnectivitySummary', () => {
  beforeEach(() => {
    callRuntimeRpcMock.mockReset()
  })

  it('keys connections by connectionId, parsing status/lastActivityAt/degradedSince', async () => {
    const store = createSliceStore()
    callRuntimeRpcMock.mockResolvedValue({
      connections: [
        { connectionId: 'conn-1', devServerId: 'dev-1', status: 'established' },
        {
          connectionId: 'conn-2',
          devServerId: 'dev-2',
          status: 'degraded',
          lastActivityAt: 1000,
          degradedSince: 2000
        }
      ]
    } as never)

    await store.getState().pollConnectivitySummary(LOCAL_TARGET)

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(LOCAL_TARGET, 'connectivity.getSummary', {})
    expect(store.getState().connections).toEqual({
      'conn-1': { status: 'established' },
      'conn-2': { status: 'degraded', lastActivityAt: 1000, degradedSince: 2000 }
    })
  })

  it('omits lastActivityAt/degradedSince instead of coercing to 0 when unset on the wire', async () => {
    const store = createSliceStore()
    callRuntimeRpcMock.mockResolvedValue({
      connections: [{ connectionId: 'conn-1', devServerId: 'dev-1', status: 'establishing' }]
    } as never)

    await store.getState().pollConnectivitySummary(LOCAL_TARGET)

    const entry = store.getState().connections['conn-1']
    expect(entry).toEqual({ status: 'establishing' })
    expect('lastActivityAt' in entry!).toBe(false)
    expect('degradedSince' in entry!).toBe(false)
  })

  it('does not throw and leaves prior connections in place when the RPC fails', async () => {
    const store = createSliceStore()
    callRuntimeRpcMock.mockResolvedValueOnce({
      connections: [{ connectionId: 'conn-1', devServerId: 'dev-1', status: 'established' }]
    } as never)
    await store.getState().pollConnectivitySummary(LOCAL_TARGET)
    const before = store.getState().connections

    callRuntimeRpcMock.mockRejectedValueOnce(new Error('boom'))
    await expect(store.getState().pollConnectivitySummary(LOCAL_TARGET)).resolves.toBeUndefined()

    expect(store.getState().connections).toBe(before)
  })
})

describe('isConnectivityLikeRpcError', () => {
  it('classifies a timeout/transport RuntimeRpcCallError code as connectivity-related', () => {
    expect(isConnectivityLikeRpcError(rpcFailure('timeout', 'request timed out'))).toBe(true)
    expect(isConnectivityLikeRpcError(rpcFailure('not_connected', 'agent not connected'))).toBe(
      true
    )
  })

  it('classifies a plain Error whose message reads as a transport timeout', () => {
    expect(isConnectivityLikeRpcError(new Error('RPC call timed out after 30000ms'))).toBe(true)
  })

  it('does NOT classify an ordinary backend logic error as connectivity-related', () => {
    expect(isConnectivityLikeRpcError(rpcFailure('validation_error', 'name is required'))).toBe(
      false
    )
    expect(isConnectivityLikeRpcError(rpcFailure('not_found', 'repo not found'))).toBe(false)
    expect(isConnectivityLikeRpcError(new Error('permission denied'))).toBe(false)
    expect(isConnectivityLikeRpcError('a string, not an Error')).toBe(false)
  })
})

describe('maybeTriggerConnectivityPollAfterRpcFailure', () => {
  beforeEach(() => {
    callRuntimeRpcMock.mockReset()
  })

  it('triggers a connectivity poll for a connectivity-looking failure', () => {
    const store = createSliceStore()
    callRuntimeRpcMock.mockResolvedValue({
      connections: [{ connectionId: 'conn-1', devServerId: 'dev-1', status: 'degraded' }]
    } as never)

    store
      .getState()
      .maybeTriggerConnectivityPollAfterRpcFailure(rpcFailure('timeout', 'timed out'), LOCAL_TARGET)

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(LOCAL_TARGET, 'connectivity.getSummary', {})
  })

  it('does NOT trigger a connectivity poll for a generic logic error', () => {
    const store = createSliceStore()

    store
      .getState()
      .maybeTriggerConnectivityPollAfterRpcFailure(
        rpcFailure('validation_error', 'name is required'),
        LOCAL_TARGET
      )

    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })
})

describe('installConnectivityPolling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('polls immediately on install, then every 30s while the document stays visible (fake timers)', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    const poll = vi.fn().mockResolvedValue(undefined)
    const getTarget = vi.fn(() => LOCAL_TARGET)

    const cleanup = installConnectivityPolling({
      getTarget,
      pollConnectivitySummary: poll,
      intervalMs: 30_000
    })

    // Installed while visible: runs once immediately.
    expect(poll).toHaveBeenCalledTimes(1)
    expect(getTarget).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000)
    expect(poll).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(30_000)
    expect(poll).toHaveBeenCalledTimes(3)

    cleanup()
    vi.advanceTimersByTime(30_000)
    expect(poll).toHaveBeenCalledTimes(3) // cleanup stops the interval

    vi.useRealTimers()
  })

  it('re-polls immediately when the window regains foreground (fake timers)', () => {
    vi.useFakeTimers()
    let visibilityState: DocumentVisibilityState = 'hidden'
    const documentListeners = new Map<string, () => void>()
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((event: string, listener: () => void) => {
        documentListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })
    const poll = vi.fn().mockResolvedValue(undefined)

    const cleanup = installConnectivityPolling({
      getTarget: () => LOCAL_TARGET,
      pollConnectivitySummary: poll,
      intervalMs: 30_000
    })

    // Installed while hidden: no immediate poll, no interval armed yet.
    expect(poll).not.toHaveBeenCalled()

    // App regains foreground.
    visibilityState = 'visible'
    documentListeners.get('visibilitychange')?.()
    expect(poll).toHaveBeenCalledTimes(1)

    // The 30s interval armed on becoming visible now fires on schedule.
    vi.advanceTimersByTime(30_000)
    expect(poll).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(30_000)
    expect(poll).toHaveBeenCalledTimes(3)

    cleanup()
    vi.useRealTimers()
  })
})
