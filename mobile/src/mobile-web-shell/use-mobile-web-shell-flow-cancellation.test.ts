import { sha256 } from '@noble/hashes/sha256'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import { createGenerationStore } from './generation-store'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { deriveHostCacheKey } from './host-cache-key'
import { useMobileWebShellSession } from './use-mobile-web-shell-session'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

const boundary = vi.hoisted((): { client: RpcClient | null } => ({ client: null }))
vi.mock('expo-crypto', async () => {
  const { sha256: hash } = await import('@noble/hashes/sha256')
  return {
    getRandomBytes: (length: number) => new Uint8Array(length),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, bytes: Uint8Array) => hash(bytes).buffer
  }
})
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('react-native', () => ({ AppState: {} }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined }
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({
    statusPending: false,
    statusReadable: true,
    hostCapabilities: [MOBILE_WEB_BUNDLE_CAPABILITY],
    hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
  })
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: boundary.client, state: 'connected' })
}))

function fixture(windows: number, byte: number) {
  const bytes = new Uint8Array(windows * 1024).fill(byte)
  const assets = [
    {
      path: 'index.html',
      byteLength: bytes.byteLength,
      sha256: Buffer.from(sha256(bytes)).toString('hex'),
      contentType: 'text/html'
    }
  ]
  const manifest: MobileWebBundleManifestRead = {
    schemaVersion: 1,
    buildId: computeMobileWebBundleId(assets),
    minCompatibleRuntimeProtocolVersion: 2,
    runtimeProtocolVersion: 5,
    pageVersion: 1,
    entrypoint: 'index.html',
    totalBytes: bytes.byteLength,
    assets,
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate'], canOwnHostArea: true }]
  }
  return { manifest, bytes }
}

function bundleHost(windows: number) {
  const old = fixture(windows, 65)
  const live = fixture(windows, 66)
  let current = old
  let holdOld = true
  const oldReads: number[] = []
  const liveReads: number[] = []
  const pending: (() => void)[] = []
  const client: RpcClient = {
    sendRequest: async (method, params): Promise<RpcResponse> => {
      if (method === 'mobileWeb.bundle.manifest') {
        return {
          id: 'manifest',
          ok: true,
          result: { manifest: current.manifest, chunkBytes: 1024 },
          _meta: { runtimeId: 'flow' }
        }
      }
      if (
        method !== 'mobileWeb.bundle.chunk' ||
        params === null ||
        typeof params !== 'object' ||
        !('buildId' in params) ||
        !('offset' in params) ||
        typeof params.offset !== 'number'
      ) {
        throw new Error('Unexpected bundle request')
      }
      const bundle = params.buildId === old.manifest.buildId ? old : live
      const offset = params.offset
      const reads = bundle === old ? oldReads : liveReads
      reads.push(offset)
      if (bundle === old && holdOld) {
        await new Promise<void>((resolve) => pending.push(resolve))
      }
      const bytes = bundle.bytes.subarray(offset, offset + 1024)
      return {
        id: 'chunk',
        ok: true,
        result: {
          buildId: bundle.manifest.buildId,
          path: 'index.html',
          offset,
          assetByteLength: bundle.bytes.byteLength,
          sha256: bundle.manifest.assets[0]!.sha256,
          dataBase64: Buffer.from(bytes).toString('base64'),
          eof: offset + bytes.byteLength >= bundle.bytes.byteLength
        },
        _meta: { runtimeId: 'flow' }
      }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return {
    client,
    old,
    live,
    oldReads,
    liveReads,
    replace: () => {
      current = live
    },
    release: () => {
      holdOld = false
      for (const resolve of pending.splice(0)) {
        resolve()
      }
    }
  }
}

let tree: ReactTestRenderer | null = null
let releaseDownload = (): void => {}
afterEach(async () => {
  releaseDownload()
  await act(async () => {
    tree?.unmount()
  })
  tree = null
})

it.each([8, 80])(
  'stops a superseded %i-window download before more reads or stale cache activation',
  async (windows) => {
    const host = bundleHost(windows)
    releaseDownload = host.release
    boundary.client = host.client
    const disk = createFakeGenerationFileSystem()
    const original = createGenerationStore({ fileSystem: disk })
    const staged: string[] = []
    const committed: string[] = []
    const store = {
      ...original,
      stageGeneration: (
        hostKey: string,
        result: Parameters<typeof original.stageGeneration>[1]
      ) => {
        staged.push(result.manifest.buildId)
        return original.stageGeneration(hostKey, result)
      },
      commitGeneration: (generation: Parameters<typeof original.commitGeneration>[0]) => {
        committed.push(generation.buildId)
        return original.commitGeneration(generation)
      }
    }
    let wide = true
    let latest: MobileWebShellSessionState | null = null
    const runtime = {
      createStore: () => store,
      mintSessionId: () => 'flow-session',
      now: () => 0,
      setForegroundTimer: () => () => {}
    }
    function Probe() {
      latest = useMobileWebShellSession({
        hostId: 'host-1',
        routePathname: '/h/host-1',
        wide,
        runtime
      }).state
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    expect(host.oldReads).toHaveLength(4)
    host.replace()
    wide = false
    await act(async () => {
      tree?.update(createElement(Probe))
    })
    expect(latest).toMatchObject({ kind: 'ready', buildId: host.live.manifest.buildId })
    expect(host.liveReads).toHaveLength(windows)
    await act(async () => {
      host.release()
    })
    const active = await store.readActiveGeneration(deriveHostCacheKey('host-1'))
    expect({
      oldReads: host.oldReads.length,
      stagedOld: staged.filter((id) => id === host.old.manifest.buildId).length,
      committedOld: committed.filter((id) => id === host.old.manifest.buildId).length,
      activeIsLive: active?.buildId === host.live.manifest.buildId
    }).toEqual({ oldReads: 4, stagedOld: 0, committedOld: 0, activeIsLive: true })
    expect(committed).toEqual([host.live.manifest.buildId])
  }
)
