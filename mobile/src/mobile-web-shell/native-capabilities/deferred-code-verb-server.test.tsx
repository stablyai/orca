import { createHash } from 'node:crypto'
import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { MobileWebBundleManifestRead } from '../../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { createFakeGenerationFileSystem } from '../generations/generation-file-system-fake'
import { deferredAssetsFiller } from '../generations/generation-deferred-assets'
import { useDeferredCodeServer } from './deferred-code-verb-server'

type FakeClient = {
  tag: string
  getState: () => ConnectionState
  onStateChange: (listener: (next: ConnectionState) => void) => () => void
  set: (next: ConnectionState) => void
  // Settles once a fill is waiting on this client.
  watched: Promise<void>
}
type Live = {
  host: { client: FakeClient | null; clientId: string | null }
  hostListeners: Set<() => void>
  fetchedWith: string[]
}
const live = vi.hoisted((): Live => ({
  host: { client: null, clientId: null },
  hostListeners: new Set(),
  fetchedWith: []
}))

vi.mock('expo-crypto', async (original) => {
  const { createHash: hash } = await import('node:crypto')
  return {
    ...(await original<object>()),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_algorithm: string, data: Uint8Array) => {
      const bytes = hash('sha256').update(data).digest()
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
  }
})
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useHostClient: () => ({ ...live.host, state: 'connected' })
}))
// The connection store as the shell sees it: one live entry per host, with state notifications.
vi.mock('../../transport/connection/client-context', () => ({
  useRpcClientContext: () => ({
    getClientId: () => live.host.clientId,
    getAllClients: () => (live.host.client ? [{ hostId: 'host-a', client: live.host.client }] : []),
    subscribeHostState: (_hostId: string, listener: () => void) => {
      live.hostListeners.add(listener)
      return () => live.hostListeners.delete(listener)
    }
  })
}))
vi.mock('../generations/generation-deferred-assets', async (original) => ({
  ...(await original<object>()),
  fetchDeferredAssetsFromDesktop: async (
    client: RpcClient & { tag: string },
    missing: readonly { sha256: string }[]
  ) => {
    live.fetchedWith.push(client.tag)
    return new Map(missing.map((asset) => [asset.sha256, new Uint8Array(engine)]))
  }
}))

const BUILD = '0'.repeat(64)
const engine = Buffer.from('export const draw = () => "diagram"\n')
const asset = {
  path: 'assets/engine.js',
  sha256: createHash('sha256').update(engine).digest('hex'),
  byteLength: engine.byteLength,
  contentType: 'text/javascript',
  kind: 'script',
  deferred: true
}
const manifest: MobileWebBundleManifestRead = {
  schemaVersion: 1,
  buildId: BUILD,
  minCompatibleRuntimeProtocolVersion: 0,
  runtimeProtocolVersion: 0,
  entrypoint: 'index.html',
  totalBytes: engine.byteLength,
  assets: [asset]
}
let renderer: ReactTestRenderer | undefined

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  live.fetchedWith.length = 0
  live.hostListeners.clear()
})

function client(tag: string, initial: ConnectionState): FakeClient {
  let state = initial
  const listeners = new Set<(next: ConnectionState) => void>()
  const watched = Promise.withResolvers<void>()
  return {
    tag,
    watched: watched.promise,
    getState: () => state,
    onStateChange: (listener) => {
      listeners.add(listener)
      watched.resolve()
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

// Publish a new live entry for the host, as the connection store does on open or replacement.
function goLive(clientId: string, next: FakeClient) {
  live.host = { client: next, clientId }
  for (const listener of live.hostListeners) {
    listener()
  }
}

// Documents are keyed by credential, as the shell remounts them; a reopen keeps them.
function setup() {
  const fs = createFakeGenerationFileSystem()
  const directory = `${fs.rootUri}/generation`
  let held: { promise: Promise<void>; resolve: () => void } | null = null
  const scanEntered = Promise.withResolvers<void>()
  let queue: Promise<unknown> = Promise.resolve()
  const fill = deferredAssetsFiller(
    fs,
    <T,>(operation: () => Promise<T>) => {
      const run = queue.then(operation)
      queue = run.catch(() => undefined)
      return run
    },
    async () => {
      if (held) {
        const release = held
        held = null
        scanEntered.resolve()
        await release.promise
      }
      return { buildId: BUILD, directory, manifest }
    }
  )
  const store = { fillDeferredAssets: fill }
  const serve = new Map<string, (params: unknown) => Promise<unknown>>()
  function Document({ name }: { name: string }) {
    serve.set(name, useDeferredCodeServer('host-a', BUILD, store))
    return null
  }
  const mount = async (...names: string[]) =>
    act(async () => {
      const credential = live.host.clientId ?? ''
      const element = createElement(
        Fragment,
        null,
        names.map((name) => createElement(Document, { key: `${credential}/${name}`, name }))
      )
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  return {
    mount,
    // Observe a rejection as soon as it happens; each test asserts the outcome later.
    request: (name = 'page') => {
      const reply = serve.get(name)?.({}) ?? Promise.reject(new Error(`no ${name} document`))
      reply.catch(() => undefined)
      return reply
    },
    holdScan: () => {
      held = Promise.withResolvers<void>()
      return { entered: scanEntered.promise, release: held }
    },
    engineOnDisk: async () =>
      (await fs.fileSize(`${directory}/${asset.path}`)) === engine.byteLength
  }
}

it('a replacement credential never joins the retired credential fill and gets a working engine', async () => {
  const doc = setup()
  const a = client('A', 'connected')
  live.host = { client: a, clientId: 'token-a' }
  await doc.mount('page')
  const hold = doc.holdScan()
  const original = doc.request()
  await hold.entered
  a.set('disconnected')
  goLive('token-b', client('B', 'connected'))
  await doc.mount('page')
  hold.release.resolve()
  await expect(doc.request()).resolves.toEqual({})
  await expect(original).rejects.toThrow('was replaced')
  expect(await doc.engineOnDisk()).toBe(true)
  expect(live.fetchedWith).toEqual(['B'])
})

it('ends a fill that was waiting on a client whose credential was replaced', async () => {
  const doc = setup()
  const a = client('A', 'connecting')
  live.host = { client: a, clientId: 'token-a' }
  await doc.mount('page')
  const original = doc.request()
  await a.watched
  a.set('disconnected')
  goLive('token-b', client('B', 'connected'))
  await doc.mount('page')
  await expect(original).rejects.toThrow('was replaced')
  await expect(doc.request()).resolves.toEqual({})
  expect(live.fetchedWith).toEqual(['B'])
})

it('keeps sharing the fill across a same-credential reopen, even while it was waiting', async () => {
  const doc = setup()
  const a = client('A', 'connecting')
  live.host = { client: a, clientId: 'token-a' }
  await doc.mount('page')
  const original = doc.request()
  await a.watched
  a.set('disconnected')
  goLive('token-a', client('A2', 'connected'))
  const later = doc.request()
  await expect(original).resolves.toEqual({})
  await expect(later).resolves.toEqual({})
  expect(await doc.engineOnDisk()).toBe(true)
  expect(live.fetchedWith).toEqual(['A2'])
})

it('finishes a shared fill for a same-credential page after the page that started it closes', async () => {
  const doc = setup()
  live.host = { client: client('A', 'connected'), clientId: 'token-a' }
  await doc.mount('starter', 'joiner')
  const hold = doc.holdScan()
  const started = doc.request('starter')
  await hold.entered
  const joined = doc.request('joiner')
  await doc.mount('joiner')
  hold.release.resolve()
  await expect(joined).resolves.toEqual({})
  await expect(started).resolves.toEqual({})
  expect(await doc.engineOnDisk()).toBe(true)
  expect(live.fetchedWith).toEqual(['A'])
})
