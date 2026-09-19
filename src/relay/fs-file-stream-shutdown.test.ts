import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { readRelayFileStreamMetadata } from './fs-handler-file-read'
import { RelayStreamRegistry } from './fs-stream-registry'
import { STREAM_CHUNK_SIZE } from './protocol'

let directory: string
let filePath: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-file-stream-shutdown-'))
  filePath = join(directory, 'sample.png')
  await writeFile(filePath, Buffer.alloc(12, 42))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function fixture() {
  const registry = new RelayStreamRegistry()
  const bulk = vi.fn(async () => {})
  const terminal = vi.fn((_id, _method, _params, settled) => {
    settled({ ok: true })
    return true
  })
  const dispatcher = { notifyBulk: bulk, tryNotifyClient: terminal } as unknown as RelayDispatcher
  const context = { clientId: 1, isStale: () => false } as RequestContext
  const start = (paceWithAcks = false) =>
    readRelayFileStreamMetadata(filePath, dispatcher, registry, context, {
      clientId: 1,
      paceWithAcks
    })
  return { registry, bulk, terminal, start }
}

it('waits for a scheduled pump and permanently fences later metadata requests', async () => {
  const f = fixture()
  const scheduled: (() => void)[] = []
  const schedule = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
    scheduled.push(callback)
    return {} as NodeJS.Immediate
  })
  await f.start()
  schedule.mockRestore()
  const finished = vi.fn()
  const drain = f.registry.disposeAll().then(finished)
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).not.toHaveBeenCalled()
  await expect(f.start()).rejects.toThrow('relay_file_stream_shutdown_fenced')
  scheduled.forEach((run) => run())
  await drain
  expect(f.bulk).not.toHaveBeenCalled()
  expect(f.terminal).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)(
  'waits for an in-flight final chunk to %s without a terminal frame',
  async (outcome) => {
    const f = fixture()
    const pending = Promise.withResolvers<void>()
    f.bulk.mockReturnValue(pending.promise)
    await f.start()
    await vi.waitFor(() => expect(f.bulk).toHaveBeenCalledOnce())
    const finished = vi.fn()
    const drain = f.registry.disposeAll().then(finished)
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).not.toHaveBeenCalled()
    if (outcome === 'resolve') {
      pending.resolve()
    } else {
      pending.reject(new Error('transport closed'))
    }
    await drain
    expect(f.terminal).not.toHaveBeenCalled()
  }
)

it('holds shutdown until a queued terminal frame settles even after the handle closes', async () => {
  const f = fixture()
  let settle: (() => void) | undefined
  f.terminal.mockImplementation((_id, _method, _params, callback) => {
    settle = () => callback({ ok: false })
    return true
  })
  await f.start()
  await vi.waitFor(() => expect(f.registry.size()).toBe(0))
  expect(settle).toBeTypeOf('function')
  const finished = vi.fn()
  const drain = f.registry.disposeAll().then(finished)
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).not.toHaveBeenCalled()
  settle!()
  await drain
})

it('wakes an ACK-parked producer during shutdown', async () => {
  const f = fixture()
  await writeFile(filePath, Buffer.alloc(STREAM_CHUNK_SIZE * 6, 42))
  await f.start(true)
  await vi.waitFor(() => expect(f.bulk).toHaveBeenCalledTimes(4))
  await f.registry.disposeAll()
  expect(f.bulk).toHaveBeenCalledTimes(4)
  expect(f.terminal).not.toHaveBeenCalled()
})

it('retains a binary-probe handle when its close fails and retries shutdown cleanup', async () => {
  const f = fixture()
  filePath = join(directory, 'sample.txt')
  await writeFile(filePath, 'text content')
  const failure = new Error('probe close failed')
  const release = f.registry.releaseUnregisteredHandle.bind(f.registry)
  vi.spyOn(f.registry, 'releaseUnregisteredHandle').mockImplementationOnce((handle) => {
    vi.spyOn(handle, 'close').mockRejectedValueOnce(failure)
    return release(handle)
  })
  try {
    await expect(f.start()).rejects.toBe(failure)
    expect(f.registry.size()).toBe(1)
    await f.registry.disposeAll()
    expect(f.registry.size()).toBe(0)
  } finally {
    await f.registry.disposeAll()
  }
})
