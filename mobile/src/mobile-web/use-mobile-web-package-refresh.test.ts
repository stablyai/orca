import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { HostProfile } from '../transport/types'

const native = vi.hoisted(() => ({ openSession: vi.fn(), closeSession: vi.fn() }))
const downloadPackage = vi.hoisted(() => vi.fn())

vi.mock('@orca/expo-mobile-web-shell', () => ({ default: native }))
vi.mock('./mobile-web-native-stager', () => ({ createMobileWebNativeStager: () => ({}) }))
vi.mock('./mobile-web-package-downloader', () => ({
  downloadMobileWebPackage: downloadPackage,
  mobileWebPackageDownloadFailureCode: () => 'test_failure'
}))

import { useMobileWebPackageRefresh } from './use-mobile-web-package-refresh'

// Why: the type-aware CI lint resolves the file: shell package as `any`, which collapses a
// union on its session type; a structural copy keeps the ref's null branch meaningful.
type OwnedSession = { sessionId: string; buildId: string; url: string }

const HOST: HostProfile = {
  id: 'host-1',
  name: 'Desktop',
  endpoint: 'wss://paired.invalid',
  deviceToken: 'secret',
  publicKeyB64: 'paired-public-key',
  lastConnected: 1
}
const BUILD_ID = 'a'.repeat(64)
const OWNED: OwnedSession = {
  sessionId: 'session-a',
  buildId: BUILD_ID,
  url: 'https://session-a.orca-mobile-web.invalid/#session-a'
}

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

describe('useMobileWebPackageRefresh', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    native.openSession.mockReset()
    native.closeSession.mockReset().mockResolvedValue(undefined)
    downloadPackage.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  // The cache probe resolves null on a host paired for the first time, so pinning reuse to it
  // re-downloaded the whole package on every later refresh of the very build already running.
  it('reuses the build the owned session already runs when the cache probe found nothing', async () => {
    let reuse: ((buildId: string) => boolean | Promise<boolean>) | undefined
    downloadPackage.mockImplementation(async (_request, _stager, options) => {
      reuse = options.reuseVerifiedBuild
      return (await options.reuseVerifiedBuild(BUILD_ID))
        ? { commit: null, reusedVerifiedBuild: true }
        : { commit: { buildId: BUILD_ID }, reusedVerifiedBuild: false }
    })

    const ownedSessionRef = ref<OwnedSession | null>(OWNED)
    function Harness(): null {
      useMobileWebPackageRefresh({
        client: { sendRequest: vi.fn() } as unknown as RpcClient,
        host: HOST,
        state: 'connected',
        packageCapability: { status: 'supported', gzip: false },
        cachedBuildProbeRef: ref({
          hostEpoch: 1,
          promise: Promise.resolve(null),
          resolve: vi.fn()
        }),
        hostEpochRef: ref(1),
        ownedSessionRef,
        rejectedBuildIdsRef: ref(new Set<string>()),
        refreshingHostEpochRef: ref<number | null>(null),
        publishSession: vi.fn(async () => true),
        refreshEpoch: 0,
        setPackageLoading: vi.fn(),
        setPackageWarning: vi.fn(),
        setPackageProgress: vi.fn()
      })
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })

    expect(await reuse?.(BUILD_ID)).toBe(true)
    expect(native.openSession).not.toHaveBeenCalled()
  })

  // A flapping link aborts the download and drops every staged byte, so an unpaced restart
  // re-downloads the whole bundle over cellular data as fast as the link comes back.
  it('paces a restart that follows an attempt which never finished downloading', async () => {
    vi.useFakeTimers()
    try {
      downloadPackage.mockImplementation(() => new Promise(() => {}))
      const props = {
        client: { sendRequest: vi.fn() } as unknown as RpcClient,
        host: HOST,
        state: 'connected',
        packageCapability: { status: 'supported', gzip: false },
        cachedBuildProbeRef: ref({
          hostEpoch: 1,
          promise: Promise.resolve(null),
          resolve: vi.fn()
        }),
        hostEpochRef: ref(1),
        ownedSessionRef: ref<OwnedSession | null>(null),
        rejectedBuildIdsRef: ref(new Set<string>()),
        refreshingHostEpochRef: ref<number | null>(null),
        publishSession: vi.fn(async () => true),
        refreshEpoch: 0,
        setPackageLoading: vi.fn(),
        setPackageWarning: vi.fn(),
        setPackageProgress: vi.fn()
      } as const
      function Harness({ swap }: { swap: number }): null {
        useMobileWebPackageRefresh({
          ...props,
          client: { sendRequest: vi.fn(), swap } as unknown as RpcClient
        })
        return null
      }

      await act(async () => {
        renderer = create(createElement(Harness, { swap: 0 }))
      })
      expect(downloadPackage).toHaveBeenCalledTimes(1)

      await act(async () => {
        renderer?.update(createElement(Harness, { swap: 1 }))
      })
      expect(downloadPackage).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_200)
      })
      expect(downloadPackage).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
