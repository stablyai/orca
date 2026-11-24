import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { createFakeGenerationFileSystem } from '../generations/generation-file-system-fake'
import { deferredAssetsFiller } from '../generations/generation-deferred-assets'
import type { GenerationStore } from '../generations/generation-store'
import { useDeferredCodeServer } from './deferred-code-verb-server'

const live = vi.hoisted(() => ({
  host: { client: null as unknown, clientId: null as string | null },
  fetchedWith: [] as string[]
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
  kind: 'script',
  deferred: true
}
let renderer: ReactTestRenderer | undefined

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  live.fetchedWith.length = 0
})

function client(tag: string, initial: ConnectionState) {
  let state = initial
  const listeners = new Set<(next: ConnectionState) => void>()
  return {
    tag,
    getState: () => state,
    onStateChange: (listener: (next: ConnectionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: ConnectionState) {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

// The shell remounts a document per credential (keyed by client id); a reopen keeps it.
function setup() {
  const fs = createFakeGenerationFileSystem()
  const directory = `${fs.rootUri}/generation`
  let held: PromiseWithResolvers<void> | null = null
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
      return { buildId: BUILD, directory, manifest: { assets: [asset] } as never }
    }
  )
  const store = { fillDeferredAssets: fill } as unknown as GenerationStore
  let serve: (params: unknown) => Promise<unknown> = async () => undefined
  function Document() {
    serve = useDeferredCodeServer('host-a', BUILD, store)
    return null
  }
  const mount = async () =>
    act(async () => {
      const element = createElement(Document, { key: live.host.clientId ?? '' })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  return {
    fs,
    mount,
    // Observe a rejection as soon as it happens; each test asserts the outcome later.
    request: () => {
      const reply = serve({})
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

const settled = (request: Promise<unknown>) =>
  Promise.race([
    request.then(
      () => 'settled',
      () => 'rejected'
    ),
    new Promise((resolve) => setTimeout(() => resolve('stranded'), 500))
  ])

it('a replacement credential never joins the retired document fill and gets a working engine', async () => {
  const doc = setup()
  const a = client('A', 'connected')
  live.host = { client: a, clientId: 'token-a' }
  await doc.mount()
  const hold = doc.holdScan()
  const original = doc.request()
  await hold.entered
  a.set('disconnected')
  live.host = { client: client('B', 'connected'), clientId: 'token-b' }
  await doc.mount()
  hold.release.resolve()
  expect(await settled(doc.request())).toBe('settled')
  expect(await settled(original)).toBe('rejected')
  expect(await doc.engineOnDisk()).toBe(true)
  expect(live.fetchedWith).toEqual(['B'])
})

it('a retired document stops waiting on its closed client', async () => {
  const doc = setup()
  const a = client('A', 'connecting')
  live.host = { client: a, clientId: 'token-a' }
  await doc.mount()
  const original = doc.request()
  a.set('disconnected')
  live.host = { client: client('B', 'connected'), clientId: 'token-b' }
  await doc.mount()
  expect(await settled(original)).toBe('rejected')
  expect(await settled(doc.request())).toBe('settled')
  expect(live.fetchedWith).toEqual(['B'])
})

it('keeps sharing the fill across a same-credential reopen', async () => {
  const doc = setup()
  const a = client('A', 'connected')
  live.host = { client: a, clientId: 'token-a' }
  await doc.mount()
  const hold = doc.holdScan()
  const original = doc.request()
  await hold.entered
  a.set('disconnected')
  live.host = { client: client('A2', 'connected'), clientId: 'token-a' }
  await doc.mount()
  const later = doc.request()
  hold.release.resolve()
  expect(await settled(original)).toBe('settled')
  expect(await settled(later)).toBe('settled')
  expect(await doc.engineOnDisk()).toBe(true)
  expect(live.fetchedWith).toEqual(['A2'])
})
