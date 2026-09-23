import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebShellSessionEvent } from './mobile-web-shell-session-contract'

/** Each place a read of the host's generation can fail, and the cause it reports. */
const doubles = vi.hoisted(() => ({
  manifest: (): Promise<unknown> => Promise.reject(new Error('no manifest staged')),
  fetch: (): Promise<unknown> => Promise.reject(new Error('no fetch staged'))
}))

vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../transport/rpc-operation', () => ({
  defineRpcOperation: (definition: unknown) => definition,
  runRpcOperation: () => doubles.manifest()
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: () => doubles.fetch()
}))

import { MobileWebBundleFetchError } from '../transport/mobile-web-bundle-fetch-refusal'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcClient } from '../transport/rpc-client'
import type { GenerationStore } from './generation-store'
import { download, readManifest } from './mobile-web-shell-session-effects'

// The mocked operations never touch the client; they only need one to exist.
const CLIENT: RpcClient = {
  sendRequest: async () => {
    throw new Error('unused')
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

const MANIFEST = {
  schemaVersion: 1,
  buildId: 'c'.repeat(64),
  minCompatibleRuntimeProtocolVersion: 2,
  runtimeProtocolVersion: 5,
  entrypoint: 'index.html',
  totalBytes: 1,
  assets: [{ path: 'index.html', sha256: '1'.repeat(64), byteLength: 1, contentType: 'text/html' }]
}

function storeThat(fail: 'stage' | 'commit' | null): GenerationStore {
  const reject = async (): Promise<never> => {
    throw new Error('simulated disk-full write')
  }
  const staged = { hostKey: 'k', buildId: MANIFEST.buildId, directory: 'd', manifest: MANIFEST }
  return {
    readActiveGeneration: async () => null,
    stageGeneration: fail === 'stage' ? reject : async () => staged,
    commitGeneration:
      fail === 'commit'
        ? reject
        : async () => ({ buildId: 'c', directory: 'd', manifest: MANIFEST }),
    abortStagedGeneration: async () => undefined,
    sweepStagedGenerations: async () => undefined,
    deleteHostCache: async () => undefined,
    persistActiveManifest: async () => 'persisted',
    recordUpdateFailure: async () => undefined,
    readUpdateFailures: async () => [],
    forgetHostUpdateFailures: async () => undefined
  }
}

function collect(): {
  events: MobileWebShellSessionEvent[]
  send: (e: MobileWebShellSessionEvent) => void
} {
  const events: MobileWebShellSessionEvent[] = []
  return { events, send: (event) => events.push(event) }
}

async function runDownload(client: RpcClient | null, store: GenerationStore) {
  const { events, send } = collect()
  await download({
    client,
    store,
    hostKey: 'k',
    flow: 3,
    runtime: {
      createStore: () => store,
      mintSessionId: () => 's',
      now: () => 0,
      setTimer: () => () => {}
    },
    startedAt: 0,
    downloads: new Set(),
    send
  })
  return events.filter((event) => event.type === 'download-failed')
}

describe('the manifest read', () => {
  beforeEach(() => {
    doubles.manifest = () => Promise.reject(new Error('no manifest staged'))
  })

  it('with no client reports no connection', async () => {
    const { events, send } = collect()
    await readManifest(null, 3, send)
    expect(events).toEqual([
      { type: 'download-failed', flow: 3, cause: { reason: 'no-connection', hostCode: null } }
    ])
  })

  it('cut off by the link reports the link', async () => {
    doubles.manifest = () => Promise.reject(markRpcDeliveryUnknown(new Error('socket closed')))
    const { events, send } = collect()
    await readManifest(CLIENT, 3, send)
    expect(events).toMatchObject([{ cause: { reason: 'connection-lost' } }])
  })

  it("refused by the host reports the host's code", async () => {
    doubles.manifest = () =>
      Promise.reject(new Error('invalid_argument: mobile_web_bundle_unavailable'))
    const { events, send } = collect()
    await readManifest(CLIENT, 3, send)
    expect(events).toMatchObject([
      { cause: { reason: 'host-refused', hostCode: 'mobile_web_bundle_unavailable' } }
    ])
  })
})

describe('the download', () => {
  beforeEach(() => {
    doubles.fetch = () =>
      Promise.resolve({
        manifest: MANIFEST,
        assets: new Map([['index.html', new Uint8Array(1)]]),
        totalBytes: 1,
        elapsedMs: 1
      })
  })

  it('with no client reports no connection', async () => {
    expect(await runDownload(null, storeThat(null))).toMatchObject([
      { cause: { reason: 'no-connection' } }
    ])
  })

  it('refusing the bytes reports the refusal', async () => {
    doubles.fetch = () =>
      Promise.reject(new MobileWebBundleFetchError('asset-checksum-mismatch', 'hashed x, not y'))
    expect(await runDownload(CLIENT, storeThat(null))).toMatchObject([
      { cause: { reason: 'asset-checksum-mismatch', hostCode: null } }
    ])
  })

  it('whose staging this phone could not write reports the cache write', async () => {
    expect(await runDownload(CLIENT, storeThat('stage'))).toMatchObject([
      { cause: { reason: 'cache-write-failed' } }
    ])
  })

  it('whose commit this phone could not write reports the cache write', async () => {
    expect(await runDownload(CLIENT, storeThat('commit'))).toMatchObject([
      { cause: { reason: 'cache-write-failed' } }
    ])
  })

  it('that lands whole reports no failure', async () => {
    expect(await runDownload(CLIENT, storeThat(null))).toEqual([])
  })
})
