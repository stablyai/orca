import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY,
  MOBILE_WEB_HYBRID_BASELINE_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'

const native = vi.hoisted(() => ({
  openSession: vi.fn(),
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
  url: 'orca-mobile-web://session-a/'
}
const SESSION_B = {
  sessionId: 'session-b',
  buildId: 'b'.repeat(64),
  url: 'orca-mobile-web://session-b/'
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
    native.closeSession.mockReset().mockResolvedValue(undefined)
    removeHostCache.mockReset().mockResolvedValue(undefined)
    downloadPackage.mockReset()
    downloadFailure.code = 'test_failure'
    sendRequest.mockReset().mockResolvedValue({
      ok: true,
      result: {
        capabilities: [
          MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY,
          MOBILE_WEB_HYBRID_BASELINE_RUNTIME_CAPABILITY
        ]
      }
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

  async function update(state: ConnectionState, host?: HostProfile | null): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Harness, { state, host }))
      await flushPromises()
    })
  }

  it('opens the single committed generation and keeps it across connection changes', async () => {
    native.openSession.mockResolvedValue(SESSION_A)

    await mount('disconnected')

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.openSession).toHaveBeenCalledWith(
      HOST.publicKeyB64,
      null,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )
    await update('reconnecting')
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.closeSession).not.toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('opens the cache once per mount rather than twice', async () => {
    native.openSession.mockResolvedValue(SESSION_A)

    await mount('disconnected')

    expect(native.openSession).toHaveBeenCalledTimes(1)
  })

  it('finishes loading when offline and no cached package opens', async () => {
    native.openSession.mockRejectedValue(new Error('mobile_web_generation_missing'))

    await mount('disconnected')

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageLoading).toBe(false)
  })

  it('does not let an offline cache probe settle a connected download', async () => {
    const cached = deferred<typeof SESSION_A>()
    native.openSession.mockReturnValue(cached.promise)
    downloadPackage.mockReturnValue(new Promise(() => {}))
    await mount('disconnected')
    await update('connected')

    await act(async () => {
      cached.reject(new Error('mobile_web_generation_missing'))
      await flushPromises()
    })

    expect(packageSession?.packageLoading).toBe(true)
  })

  it('publishes the refreshed build and closes the generation it replaced', async () => {
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      Promise.resolve(buildId ? SESSION_B : SESSION_A)
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })

    await mount('connected')

    expect(packageSession?.session).toEqual(SESSION_B)
    expect(packageSession?.packageLoading).toBe(false)
    expect(native.openSession).toHaveBeenCalledWith(
      HOST.publicKeyB64,
      SESSION_B.buildId,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('does not download again when the cached generation already is the host build', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockImplementation(async (_request, _stager, options) => {
      const reused = await options.reuseVerifiedBuild(SESSION_A.buildId)
      return { commit: reused ? null : { buildId: SESSION_A.buildId }, reusedVerifiedBuild: reused }
    })

    await mount('connected')

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.openSession).toHaveBeenCalledTimes(1)
    expect(packageSession?.packageLoading).toBe(false)
  })

  it('keeps a refresh from restarting when a connected render changes nothing', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')
    const downloads = downloadPackage.mock.calls.length
    expect(downloads).toBe(1)

    await update('connected')

    expect(downloadPackage).toHaveBeenCalledTimes(downloads)
  })

  it('does not touch the cache or the package RPCs while capability is pending', async () => {
    const status = deferred<Awaited<ReturnType<RpcClient['sendRequest']>>>()
    sendRequest.mockReturnValue(status.promise)
    native.openSession.mockResolvedValue(SESSION_A)

    await mount('connected')

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageLoading).toBe(true)
    expect(native.openSession).not.toHaveBeenCalled()
    expect(downloadPackage).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'no package support', capabilities: [] },
    {
      name: 'package support without the hybrid baseline',
      capabilities: [MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY]
    }
  ])('drops the cached interface and asks for a Desktop update for $name', async (scenario) => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')
    expect(packageSession?.session).toEqual(SESSION_A)

    sendRequest.mockResolvedValue({ ok: true, result: { capabilities: scenario.capabilities } })
    await update('connected')

    expect(packageSession?.session).toBeNull()
    expect(packageSession?.packageLoading).toBe(false)
    expect(packageSession?.packageWarning).toEqual({
      message: 'Update Orca on Desktop to continue.',
      code: 'host_update_required'
    })
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
    expect(downloadPackage).not.toHaveBeenCalled()
  })

  it('reports a refresh failure without discarding the cached interface', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockRejectedValue(new Error('host detail'))
    downloadFailure.code = 'host_error'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await mount('connected')

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(packageSession?.packageLoading).toBe(false)
    expect(packageSession?.packageWarning).toEqual({
      message: 'Couldn’t update from Desktop. Showing the last version that worked.',
      code: 'host_error'
    })
    warn.mockRestore()
  })

  it('drops the host cache and downloads again when the page cannot load', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_A)
    const downloads = downloadPackage.mock.calls.length

    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_document_http_403')
      await flushPromises()
    })

    expect(removeHostCache).toHaveBeenCalledWith(HOST.publicKeyB64)
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
    expect(downloadPackage.mock.calls.length).toBeGreaterThan(downloads)
    // The redownload succeeded, so the shell is serving a generation again with no notice left.
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(packageSession?.packageWarning).toBeUndefined()
  })

  it('removes the cache before reopening it, never the other way round', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')
    const order: string[] = []
    removeHostCache.mockImplementation(async () => {
      order.push('remove')
    })
    native.openSession.mockImplementation(async () => {
      order.push('open')
      return SESSION_A
    })

    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })

    expect(order[0]).toBe('remove')
  })

  it('re-downloads once per host selection, not once per failed load', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')

    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })
    removeHostCache.mockClear()
    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })

    expect(removeHostCache).not.toHaveBeenCalled()
    expect(packageSession?.packageWarning).toEqual({
      message: 'Couldn’t open Orca.',
      code: 'mobile_web_generation_invalid'
    })
  })

  it('allows recovery again after the desktop upgrades its build', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')
    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })

    await update('disconnected')
    native.openSession.mockResolvedValue(SESSION_B)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })
    await update('connected')
    expect(packageSession?.session).toEqual(SESSION_B)
    removeHostCache.mockClear()
    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })

    expect(removeHostCache).toHaveBeenCalledWith(HOST.publicKeyB64)
  })

  it('does not reopen a new host when an old host cache removal finishes', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')
    const removal = deferred<void>()
    removeHostCache.mockReturnValue(removal.promise)
    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })
    native.openSession.mockResolvedValue(SESSION_B)
    await update('disconnected', HOST_B)
    native.openSession.mockClear()
    native.closeSession.mockClear()

    await act(async () => {
      removal.resolve()
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_B)
    expect(native.openSession).not.toHaveBeenCalled()
    expect(native.closeSession).not.toHaveBeenCalled()
  })

  it('allows another drop after the host is selected again', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_A.buildId } })
    await mount('connected')
    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })

    await update('connected', HOST_B)
    removeHostCache.mockClear()
    await act(async () => {
      packageSession?.handleLoadFailure('mobile_web_generation_invalid')
      await flushPromises()
    })

    expect(removeHostCache).toHaveBeenCalledWith(HOST_B.publicKeyB64)
  })

  it('restarts the view in place when the WebView process is lost', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')
    expect(packageSession?.viewEpoch).toBe(0)

    await act(async () => {
      packageSession?.handleProcessTerminated(SESSION_A.sessionId)
      await flushPromises()
    })

    expect(packageSession?.viewEpoch).toBe(1)
    expect(packageSession?.session).toEqual(SESSION_A)
    expect(packageSession?.packageWarning).toEqual({
      message: 'Orca stopped unexpectedly and restarted.'
    })
    expect(removeHostCache).not.toHaveBeenCalled()
  })

  it('ignores a process loss reported for a session it no longer owns', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')

    await act(async () => {
      packageSession?.handleProcessTerminated(SESSION_B.sessionId)
      await flushPromises()
    })

    expect(packageSession?.viewEpoch).toBe(0)
    expect(packageSession?.packageWarning).toBeUndefined()
  })

  it('does not let a delayed cache open replace a refreshed build', async () => {
    const cached = deferred<typeof SESSION_A>()
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      buildId ? Promise.resolve(SESSION_B) : cached.promise
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })
    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_B)

    await act(async () => {
      cached.resolve(SESSION_A)
      await cached.promise
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_B)
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('closes a refreshed session opened after its connection was abandoned', async () => {
    const refreshed = deferred<typeof SESSION_B>()
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      buildId ? refreshed.promise : Promise.resolve(SESSION_A)
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })
    await mount('connected')
    expect(packageSession?.session).toEqual(SESSION_A)
    await update('disconnected')

    await act(async () => {
      refreshed.resolve(SESSION_B)
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_B.sessionId)
    expect(native.closeSession).not.toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('keeps the cached page when disconnected while waiting for a native alert', async () => {
    const alertClosed = deferred<void>()
    beforeSessionReplacement = vi.fn(() => alertClosed.promise)
    native.openSession.mockImplementation((_host: string, buildId: string | null) =>
      Promise.resolve(buildId ? SESSION_B : SESSION_A)
    )
    downloadPackage.mockResolvedValue({ commit: { buildId: SESSION_B.buildId } })
    await mount('connected')
    expect(beforeSessionReplacement).toHaveBeenCalledTimes(1)
    expect(packageSession?.session).toEqual(SESSION_A)

    await update('disconnected')
    await act(async () => {
      alertClosed.resolve()
      await flushPromises()
    })

    expect(packageSession?.session).toEqual(SESSION_A)
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_B.sessionId)
    expect(native.closeSession).not.toHaveBeenCalledWith(SESSION_A.sessionId)
  })

  it('closes the previous host session when the selected host changes', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')
    native.openSession.mockResolvedValue(SESSION_B)

    await update('disconnected', HOST_B)

    expect(packageSession?.session).toEqual(SESSION_B)
    expect(packageSession?.sessionHostId).toBe(HOST_B.id)
    expect(native.closeSession).toHaveBeenCalledWith(SESSION_A.sessionId)
    expect(native.openSession).toHaveBeenLastCalledWith(
      HOST_B.publicKeyB64,
      null,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )
  })

  it('surfaces a shell warning without touching the package', async () => {
    native.openSession.mockResolvedValue(SESSION_A)
    await mount('disconnected')

    await act(async () => {
      packageSession?.showWarning('That link can’t be opened here.')
      await flushPromises()
    })

    expect(packageSession?.packageWarning).toEqual({
      message: 'That link can’t be opened here.',
      code: undefined
    })
    expect(packageSession?.session).toEqual(SESSION_A)
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
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}
