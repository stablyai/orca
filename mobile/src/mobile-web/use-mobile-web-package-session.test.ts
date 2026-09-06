import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'

const native = vi.hoisted(() => ({
  openSession: vi.fn(),
  recoverSession: vi.fn(),
  markSessionHealthy: vi.fn(),
  closeSession: vi.fn()
}))
const downloadPackage = vi.hoisted(() => vi.fn())
const downloadFailure = vi.hoisted(() => ({ code: 'test_failure' }))
const removeHostCache = vi.hoisted(() => vi.fn())

vi.mock('@orca/expo-mobile-web-shell', () => ({ default: native }))
vi.mock('./mobile-web-native-stager', () => ({
  createMobileWebNativeStager: () => ({}),
  removeMobileWebHostCache: removeHostCache
}))
vi.mock('./mobile-web-package-downloader', () => ({
  downloadMobileWebPackage: downloadPackage,
  mobileWebPackageDownloadFailureCode: () => downloadFailure.code
}))

import {
  useMobileWebPackageSession,
  type MobileWebPackageSession
} from './use-mobile-web-package-session'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'

const HOST: HostProfile = {
  id: 'host-1',
  name: 'Desktop',
  endpoint: 'wss://paired.invalid',
  deviceToken: 'secret',
  publicKeyB64: 'paired-public-key',
  lastConnected: 1
}
const HOST_B: HostProfile = { ...HOST, id: 'host-2', publicKeyB64: 'paired-public-key-2' }
const sendRequest = vi.fn<RpcClient['sendRequest']>()
const CLIENT = { sendRequest } as unknown as RpcClient
const SESSION_A = {
  sessionId: 'session-a',
  buildId: 'a'.repeat(64),
  url: 'orca-mobile-web://session-a/index.html'
}
const SESSION_B = {
  sessionId: 'session-b',
  buildId: 'b'.repeat(64),
  url: 'orca-mobile-web://session-b/index.html'
}

describe('useMobileWebPackageSession', () => {
  let renderer: ReactTestRenderer | null = null
  let packageSession: MobileWebPackageSession | null = null
  let beforeSessionReplacement: (() => Promise<void>) | undefined

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    packageSession = null
    beforeSessionReplacement = undefined
    native.openSession.mockReset()
    native.recoverSession.mockReset()
    native.markSessionHealthy.mockReset().mockResolvedValue({ buildId: SESSION_A.buildId })
    native.closeSession.mockReset().mockResolvedValue(undefined)
    removeHostCache.mockReset().mockResolvedValue(undefined)
    downloadPackage.mockReset()
    downloadFailure.code = 'test_failure'
    sendRequest.mockReset().mockResolvedValue({
      ok: true,
      result: { capabilities: [MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY] }
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({
    state,
    host = HOST
  }: {
    state: ConnectionState
    host?: HostProfile | null
  }): null {
    packageSession = useMobileWebPackageSession({
      client: state === 'connected' ? CLIENT : null,
      host: host ?? undefined,
      state,
      beforeSessionReplacement
    })
    return null
  }

  async function mount(state: ConnectionState): Promise<void> {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { state }))
        await flushPromises()
      })
    } finally {
      consoleSpy.mockRestore()
    }
  }

  it('keeps the cached session mounted across connection-state changes', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.openSession).toHaveBeenCalledWith(
      HOST.publicKeyB64,
      null,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )

    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'reconnecting' }))
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.closeSession).not.toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('keeps a supported session mounted when the host disconnects', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_A)

    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'disconnected' }))
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.closeSession).not.toHaveBeenCalledWith(SESSION_A.sessionId)
    expect(native.openSession).toHaveBeenCalledTimes(1)
  })

  it('keeps a supported session mounted while a reconnected client is probed', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_A)

    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'disconnected' }))
      await flushPromises()
    })
    const status = deferred<Awaited<ReturnType<RpcClient['sendRequest']>>>()
    sendRequest.mockReturnValue(status.promise)
    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'connected' }))
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.closeSession).not.toHaveBeenCalledWith(SESSION_A.sessionId)
    await act(async () => {
      status.resolve({
        ok: true,
        result: { capabilities: [MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY] }
      })
      await status.promise
      await flushPromises()
    })
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.openSession).toHaveBeenCalledTimes(1)
  })

  it('does not open cache or request package RPCs while capability status is pending', async () => {
    const status = deferred<Awaited<ReturnType<RpcClient['sendRequest']>>>()
    sendRequest.mockReturnValue(status.promise)
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })

    await mount('connected')

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageLoading).toBe(true)
    expect(native.openSession).not.toHaveBeenCalled()
    expect(downloadPackage).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledWith('status.get')
  })

  it('does not restart package refresh when a connected render has no capability change', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })
    await mount('connected')
    const refreshCount = downloadPackage.mock.calls.length
    expect(refreshCount).toBeGreaterThan(0)

    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'connected' }))
      await flushPromises()
    })

    expect(downloadPackage).toHaveBeenCalledTimes(refreshCount)
  })

  it('removes cached UI and surfaces update-required for an unsupported connected host', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')
    expect(packageSession?.session).toEqual(SESSION_A)

    sendRequest.mockResolvedValue({ ok: true, result: { capabilities: [] } })
    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'connected' }))
      await flushPromises()
    })

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageLoading).toBe(false)
    expect(packageSession?.packageWarning).toEqual({
      message: 'Update Orca on Desktop to continue.',
      code: 'host_update_required'
    })
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
    expect(downloadPackage).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed status capabilities before cache or package access', async () => {
    sendRequest.mockResolvedValue({
      ok: true,
      result: { capabilities: [MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY, 42] }
    })
    native.openSession.mockResolvedValue(SESSION_A)

    await mount('connected')

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageWarning).toEqual({
      message: 'Update Orca on Desktop to continue.',
      code: 'host_update_required'
    })
    expect(native.openSession).not.toHaveBeenCalled()
    expect(downloadPackage).not.toHaveBeenCalled()
  })

  it('does not let a delayed cache open replace a refreshed build', async () => {
    const cached = deferred<typeof SESSION_A>()
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      buildId ? Promise.resolve(SESSION_B) : cached.promise
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })
    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_B)
    expect(downloadPackage).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Object),
      expect.objectContaining({ shellBridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION })
    )
    expect(native.openSession).toHaveBeenCalledWith(
      HOST.publicKeyB64,
      SESSION_B.buildId,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )

    await act(async () => {
      cached.resolve(SESSION_A)
      await cached.promise
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_B)
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('ignores a late health result after the owned session generation changes', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')
    const delayedHealth = deferred<{ buildId: string }>()
    native.markSessionHealthy.mockReturnValue(delayedHealth.promise)
    const health = packageSession?.markHealthy(SESSION_A.sessionId)

    native.openSession.mockResolvedValue(SESSION_B)
    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'disconnected', host: HOST_B }))
      await flushPromises()
    })
    expect(packageSession?.session).toEqual(SESSION_B)

    await act(async () => {
      delayedHealth.resolve({ buildId: SESSION_A.buildId })
      await health
    })

    expect(mobileWebDiagnosticsStore.get(HOST.id)).not.toMatchObject({ healthStatus: 'healthy' })
  })

  it('skips staging and replacement activation when cache verification finishes first', async () => {
    const manifestReady = deferred<void>()
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockImplementation(async (_request, _stager, options) => {
      await manifestReady.promise
      const reused = await options.reuseVerifiedBuild(SESSION_A.buildId)
      return {
        manifest: { buildId: SESSION_A.buildId },
        commit: reused ? null : { buildId: SESSION_A.buildId },
        reusedVerifiedBuild: reused
      }
    })

    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_A)

    await act(async () => {
      manifestReady.resolve()
      await manifestReady.promise
      await flushPromises()
    })

    expect(native.openSession).toHaveBeenCalledTimes(1)
    expect(native.openSession).toHaveBeenCalledWith(
      HOST.publicKeyB64,
      null,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )
    expect(packageSession?.packageLoading).toBe(false)
  })

  it('waits for cache verification when the manifest finishes first', async () => {
    const cached = deferred<typeof SESSION_A>()
    let reuseCheckStarted = false
    native.openSession.mockReturnValue(cached.promise)
    downloadPackage.mockImplementation(async (_request, _stager, options) => {
      reuseCheckStarted = true
      const reused = await options.reuseVerifiedBuild(SESSION_A.buildId)
      return {
        manifest: { buildId: SESSION_A.buildId },
        commit: reused ? null : { buildId: SESSION_A.buildId },
        reusedVerifiedBuild: reused
      }
    })

    await mount('connected')
    expect(reuseCheckStarted).toBe(true)
    expect(packageSession?.session).toBeNull()

    await act(async () => {
      cached.resolve(SESSION_A)
      await cached.promise
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.openSession).toHaveBeenCalledTimes(1)
    expect(packageSession?.packageLoading).toBe(false)
  })

  it('keeps the current session published until replacement is safe', async () => {
    const safe = deferred<void>()
    beforeSessionReplacement = () => safe.promise
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      Promise.resolve(buildId ? SESSION_B : SESSION_A)
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })

    await mount('connected')

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.openSession).toHaveBeenCalledWith(
      HOST.publicKeyB64,
      SESSION_B.buildId,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )
    expect(native.closeSession).not.toHaveBeenCalledWith(SESSION_A.sessionId)

    await act(async () => {
      safe.resolve()
      await safe.promise
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_B)
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('rejects a replacement whose host becomes stale while activation waits', async () => {
    const safe = deferred<void>()
    beforeSessionReplacement = () => safe.promise
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      Promise.resolve(buildId ? SESSION_B : SESSION_A)
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })

    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_A)

    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'connected', host: null }))
      await flushPromises()
    })
    await act(async () => {
      safe.resolve()
      await safe.promise
      await flushPromises()
    })

    expect(packageSession?.session).toBeNull()
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_B.sessionId)
  })

  it('keeps the loading state while a first desktop refresh is active', async () => {
    const refresh = deferred<{ commit: { buildId: string } }>()
    let reportProgress:
      | ((progress: { phase: 'downloading'; completedBytes: number; totalBytes: number }) => void)
      | undefined
    native.openSession.mockRejectedValue(new Error('cache unavailable'))
    downloadPackage.mockImplementation((_request, _stager, options) => {
      reportProgress = options.onProgress
      return refresh.promise
    })

    await mount('connected')

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageLoading).toBe(true)
    expect(packageSession?.packageWarning).toBeUndefined()

    await act(async () => {
      reportProgress?.({ phase: 'downloading', completedBytes: 50, totalBytes: 100 })
      await flushPromises()
    })
    expect(packageSession?.packageProgress).toEqual({
      phase: 'downloading',
      completedBytes: 50,
      totalBytes: 100
    })

    await act(async () => {
      refresh.reject(new Error('refresh failed'))
      await refresh.promise.catch(() => {})
      await flushPromises()
    })
  })

  it('recovers a session that misses its interactive health deadline', async () => {
    native.openSession.mockResolvedValue(SESSION_B)
    native.recoverSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')

    await act(async () => {
      await packageSession?.handleHealthTimeout(SESSION_B.sessionId)
    })

    expect(native.recoverSession).toHaveBeenCalledWith(SESSION_B.sessionId)
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(mobileWebDiagnosticsStore.get(HOST.id)).toMatchObject({
      buildId: SESSION_A.buildId,
      packageSource: 'verified-cache',
      healthStatus: 'recovered',
      recoveryCount: 1,
      lastFailureCode: 'health_timeout'
    })
  })

  // Reloading the view restarts the deadline that expired, so an unbounded restart livelocks a
  // page that simply needs longer than one deadline: it never gets to finish loading.
  it('keeps the page mounted when a health timeout has nothing to recover to', async () => {
    native.openSession.mockResolvedValue(SESSION_B)
    native.recoverSession.mockRejectedValue(new Error('no previous generation'))
    await mount('disconnected')

    await act(async () => {
      await packageSession?.handleHealthTimeout(SESSION_B.sessionId)
      await packageSession?.handleHealthTimeout(SESSION_B.sessionId)
    })

    expect(packageSession?.viewEpoch).toBe(0)
    expect(packageSession?.session).toEqual(SESSION_B)
    expect(packageSession?.packageWarning).toEqual({
      message:
        'Orca is taking longer than usual to start. There’s no earlier version to go back to.',
      code: 'no_previous_version'
    })
  })

  it.each([
    ['incompatible_bridge', 'Update Orca Mobile to get the latest from Desktop.'],
    ['test_failure', 'Couldn’t update from Desktop. Showing the last version that worked.']
  ])('retains a cached session after %s package refresh failure', async (code, warning) => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadFailure.code = code
    downloadPackage.mockRejectedValue(new Error(code))

    await mount('connected')

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(packageSession?.packageWarning).toEqual({ message: warning, code })
  })

  it.each([
    ['incompatible_bridge', 'Update Orca Mobile to open Desktop.'],
    ['test_failure', 'Couldn’t load Desktop.']
  ])('reports %s package refresh failure without a cached session', async (code, warning) => {
    native.openSession.mockRejectedValue(new Error('cache unavailable'))
    downloadFailure.code = code
    downloadPackage.mockRejectedValue(new Error(code))

    await mount('connected')

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageLoading).toBe(false)
    expect(packageSession?.packageWarning).toEqual({ message: warning, code })
  })

  it('remounts after isolated process loss and rolls back a crash loop', async () => {
    native.openSession.mockResolvedValue(SESSION_B)
    native.recoverSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')

    await act(async () => {
      await packageSession?.handleProcessTerminated(SESSION_B.sessionId)
      await packageSession?.markHealthy(SESSION_B.sessionId)
    })
    expect(packageSession?.viewEpoch).toBe(1)
    expect(packageSession?.packageWarning).toEqual({
      message: 'Orca stopped unexpectedly and restarted.'
    })
    expect(native.recoverSession).not.toHaveBeenCalled()

    await act(async () => {
      await packageSession?.handleProcessTerminated(SESSION_B.sessionId)
      await packageSession?.handleProcessTerminated(SESSION_B.sessionId)
    })

    expect(native.recoverSession).toHaveBeenCalledWith(SESSION_B.sessionId)
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(mobileWebDiagnosticsStore.get(HOST.id)).toMatchObject({
      buildId: SESSION_A.buildId,
      healthStatus: 'recovered',
      recoveryCount: 1,
      lastFailureCode: 'webview_crash_loop'
    })
  })

  it('lets the native recovery UI restore the previous generation', async () => {
    native.openSession.mockResolvedValue(SESSION_B)
    native.recoverSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')

    await act(async () => {
      await packageSession?.recoverPrevious()
    })

    expect(native.recoverSession).toHaveBeenCalledWith(SESSION_B.sessionId)
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(packageSession?.packageWarning).toEqual({
      message: 'Went back to the last version that worked.'
    })
  })

  it('clears only the selected host cache and downloads it again', async () => {
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      Promise.resolve(buildId ? SESSION_B : SESSION_A)
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })
    await mount('disconnected')

    await act(async () => {
      await packageSession?.clearCache()
    })

    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
    expect(removeHostCache).toHaveBeenCalledWith(HOST.publicKeyB64)
    expect(packageSession?.session).toBeNull()

    await act(async () => {
      renderer?.update(createElement(Harness, { state: 'connected' }))
      await flushPromises()
    })

    expect(downloadPackage).toHaveBeenCalled()
    expect(packageSession?.session).toEqual(SESSION_B)
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
