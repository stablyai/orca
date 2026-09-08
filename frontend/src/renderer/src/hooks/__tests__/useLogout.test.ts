// @vitest-environment happy-dom
import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useLogout } from '../useLogout'
import { useAppStore } from '../../store'
import * as authApiClient from '../../auth/auth-api-client'
import * as runtimeRpcClient from '../../runtime/runtime-rpc-client'

vi.mock('../../store', () => ({
  useAppStore: vi.fn()
}))
vi.mock('../../auth/auth-api-client')
vi.mock('../../runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof runtimeRpcClient>()
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
  }
})

const mockClearAuth = vi.fn()

// FE-TASK-STORAGE-016: ConnectivitySlice's real shape (FE-TASK-STORAGE-014) —
// `connections` lives directly on the store, keyed by connectionId.
function mockStoreState(overrides: {
  settings?: { activeRuntimeEnvironmentId?: string | null }
  connections?: Record<string, unknown>
}): void {
  const state = {
    clearAuth: mockClearAuth,
    settings: overrides.settings ?? { activeRuntimeEnvironmentId: null },
    connections: overrides.connections ?? {}
  }
  vi.mocked(useAppStore).mockImplementation((selector: (s: typeof state) => unknown) =>
    selector(state)
  )
  ;(useAppStore as unknown as { getState: () => typeof state }).getState = () => state
}

describe('useLogout', () => {
  beforeEach(() => {
    mockStoreState({})
    // Stub window.location.href setter
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true
    })
    window.confirm = vi.fn().mockReturnValue(true)
    vi.spyOn(localStorage, 'clear').mockImplementation(() => {})
    vi.spyOn(sessionStorage, 'clear').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('calls logoutUser API then clearAuth', async () => {
    vi.mocked(authApiClient.logoutUser).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useLogout())
    await act(async () => {
      await result.current()
    })
    expect(authApiClient.logoutUser).toHaveBeenCalledOnce()
    expect(mockClearAuth).toHaveBeenCalledOnce()
  })

  it('still clears auth even if logoutUser throws', async () => {
    vi.mocked(authApiClient.logoutUser).mockRejectedValueOnce(new Error('Network'))
    const { result } = renderHook(() => useLogout())
    await act(async () => {
      await result.current()
    })
    // clearAuth must still be called despite the API error
    expect(mockClearAuth).toHaveBeenCalledOnce()
  })

  it('redirects to /login after logout', async () => {
    vi.mocked(authApiClient.logoutUser).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useLogout())
    await act(async () => {
      await result.current()
    })
    expect(window.location.href).toBe('/login')
  })

  it('does nothing if the user cancels the confirm dialog', async () => {
    window.confirm = vi.fn().mockReturnValue(false)
    vi.mocked(authApiClient.logoutUser).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useLogout())
    await act(async () => {
      await result.current()
    })
    expect(authApiClient.logoutUser).not.toHaveBeenCalled()
    expect(runtimeRpcClient.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mockClearAuth).not.toHaveBeenCalled()
    expect(localStorage.clear).not.toHaveBeenCalled()
    expect(sessionStorage.clear).not.toHaveBeenCalled()
    expect(window.location.href).toBe('')
  })

  it('calls closeAllActiveSessions() (connection.teardown) before localStorage.clear()', async () => {
    mockStoreState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      connections: { 'conn-a': { status: 'established' }, 'conn-b': { status: 'degraded' } }
    })
    vi.mocked(authApiClient.logoutUser).mockResolvedValueOnce(undefined)
    vi.mocked(runtimeRpcClient.callRuntimeRpc).mockResolvedValue(undefined)

    const callOrder: string[] = []
    vi.mocked(runtimeRpcClient.callRuntimeRpc).mockImplementation(async (...args) => {
      callOrder.push(`teardown:${(args[2] as { connectionId: string }).connectionId}`)
      return undefined
    })
    vi.spyOn(localStorage, 'clear').mockImplementation(() => {
      callOrder.push('storage.clear')
    })
    vi.spyOn(sessionStorage, 'clear').mockImplementation(() => {
      callOrder.push('storage.clear')
    })

    const { result } = renderHook(() => useLogout())
    await act(async () => {
      await result.current()
    })

    expect(runtimeRpcClient.callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(runtimeRpcClient.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'connection.teardown',
      { connectionId: 'conn-a' }
    )
    expect(runtimeRpcClient.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'connection.teardown',
      { connectionId: 'conn-b' }
    )
    // Both teardown calls must be issued before any storage.clear() call.
    const firstStorageClearIndex = callOrder.indexOf('storage.clear')
    const teardownIndexes = callOrder
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith('teardown:'))
      .map(({ index }) => index)
    expect(teardownIndexes.every((index) => index < firstStorageClearIndex)).toBe(true)
  })

  it('does not throw and still completes logout when some teardown calls reject', async () => {
    mockStoreState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      connections: { 'conn-a': { status: 'established' }, 'conn-b': { status: 'degraded' } }
    })
    vi.mocked(authApiClient.logoutUser).mockResolvedValueOnce(undefined)
    vi.mocked(runtimeRpcClient.callRuntimeRpc).mockImplementation(
      async (_target, _method, params) => {
        const { connectionId } = params as { connectionId: string }
        if (connectionId === 'conn-a') {
          throw new Error('teardown failed')
        }
        return undefined
      }
    )

    const { result } = renderHook(() => useLogout())
    await expect(
      act(async () => {
        await result.current()
      })
    ).resolves.not.toThrow()

    expect(mockClearAuth).toHaveBeenCalledOnce()
    expect(window.location.href).toBe('/login')
  })

  it('is a no-op for closeAllActiveSessions() on a desktop-local target', async () => {
    mockStoreState({
      settings: { activeRuntimeEnvironmentId: null },
      connections: { 'conn-a': { status: 'established' } }
    })
    vi.mocked(authApiClient.logoutUser).mockResolvedValueOnce(undefined)

    const { result } = renderHook(() => useLogout())
    await act(async () => {
      await result.current()
    })

    expect(runtimeRpcClient.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mockClearAuth).toHaveBeenCalledOnce()
  })
})
