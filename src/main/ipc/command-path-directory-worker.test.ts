import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DirectoryWorkerClient from './command-path-directory-worker-client'
import { DetectionDirectoryWorkerClient } from './command-path-directory-worker-client'
import type { DetectionDirectoryRequest } from './command-path-directory-worker-protocol'

const listing = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./command-path-directory-worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof DirectoryWorkerClient>()),
  readDetectionDirectoryViaWorker: listing.read
}))

import { findCommandsOnLocalPath } from './command-path-resolver'

const entry = pathToFileURL(path.join(__dirname, 'command-path-directory-worker-entry.ts')).href
const fixture = path.join(__dirname, 'command-path-directory-worker.test-fixtures.mjs')
const clients: DetectionDirectoryWorkerClient[] = []
let dir = ''

function client(factory: ConstructorParameters<typeof DetectionDirectoryWorkerClient>[0]) {
  const value = new DetectionDirectoryWorkerClient(factory)
  clients.push(value)
  listing.read.mockImplementation((directory: string) => value.read(directory))
  return value
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orca-detection-dir-'))
})

afterEach(async () => {
  for (const value of clients.splice(0)) {
    value.dispose()
  }
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('detection directory worker boundary', () => {
  it('keeps a plain Node CLI alive for pending listings and lets it exit while idle', async () => {
    await writeFile(path.join(dir, 'found'), '')
    const result = await runProcess({
      program: process.execPath,
      args: [fixture, dir],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 5_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(JSON.stringify([['found', 'found']]))
  })

  it('keeps real unknown-Dirent metadata off the caller and closes the bounded listing before candidate fallback', async () => {
    const names = Array.from({ length: 129 }, (_, index) => `unrelated-${index}`)
    await Promise.all(names.map((name) => writeFile(path.join(dir, name), '')))
    await writeFile(path.join(dir, 'found'), '')
    await chmod(path.join(dir, 'found'), 0o755)
    const counters = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT))
    client(
      () =>
        new Worker(fixture, {
          workerData: {
            entry,
            unknownDirectory: { dir, names, counters: counters.buffer, holdMetadata: true }
          }
        })
    )
    const result = findCommandsOnLocalPath(['found', 'absent1', 'absent2', 'absent3', 'absent4'], {
      env: { PATH: dir }
    })
    try {
      // The caller can run while Node's actual lstatSync is blocked inside the worker.
      await vi.waitFor(() => expect(Atomics.load(counters, 3)).toBe(1))
    } finally {
      Atomics.store(counters, 4, 1)
      Atomics.notify(counters, 4)
    }
    await expect(result).resolves.toEqual(new Set(['found']))
    expect(Atomics.load(counters, 0)).toBe(129)
    expect(Atomics.load(counters, 1)).toBe(1)
    expect(Atomics.load(counters, 2)).toBe(1)
  })

  it('reuses the worker and preserves small-directory absence batching', async () => {
    await writeFile(path.join(dir, 'unrelated'), '')
    const factory = vi.fn(() => new Worker(fixture, { workerData: { entry } }))
    const value = client(factory)
    await expect(value.read(dir)).resolves.toEqual(new Map([['unrelated', 'unrelated']]))
    await expect(
      findCommandsOnLocalPath(['a', 'b', 'c', 'd', 'e'], { env: { PATH: dir } })
    ).resolves.toEqual(new Set())
    expect(factory).toHaveBeenCalledTimes(1)
    await expect(value.read(path.join(dir, 'missing'))).resolves.toEqual(new Map())
  })

  it('still finds a stable executable when an unknown Dirent disappears during iteration', async () => {
    await writeFile(path.join(dir, 'found'), '')
    await chmod(path.join(dir, 'found'), 0o755)
    const counters = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT))
    client(
      () =>
        new Worker(fixture, {
          workerData: {
            entry,
            unknownDirectory: {
              dir,
              names: ['deleted-neighbor', 'found'],
              counters: counters.buffer
            }
          }
        })
    )
    await expect(
      findCommandsOnLocalPath(['found', 'b', 'c', 'd', 'e'], { env: { PATH: dir }, cwd: dir })
    ).resolves.toEqual(new Set(['found']))
    expect(Atomics.load(counters, 0)).toBe(1)
    expect(Atomics.load(counters, 1)).toBe(1)
    expect(Atomics.load(counters, 2)).toBe(1)
  })

  it('uses async executable probes when the worker cannot start', async () => {
    await writeFile(path.join(dir, 'found'), '')
    await chmod(path.join(dir, 'found'), 0o755)
    client(() => {
      throw new Error('worker unavailable')
    })
    await expect(
      findCommandsOnLocalPath(['found', 'b', 'c', 'd', 'e'], { env: { PATH: dir } })
    ).resolves.toEqual(new Set(['found']))
  })

  it('completes a listing while an unrelated directory read is still pending', async () => {
    const slowDir = path.join(dir, 'slow')
    const value = client(
      () =>
        new Worker(fixture, {
          workerData: { entry, blockedDirectory: slowDir }
        })
    )
    let settled = false
    const slow = value.read(slowDir).then((names) => {
      settled = true
      return names
    })
    await expect(value.read(dir)).resolves.toEqual(new Map())
    expect(settled).toBe(false)
    value.dispose()
    await expect(slow).resolves.toBeNull()
  })

  it.each(['error', 'exit', 'post failure'])('settles pending listings after %s', async (fault) => {
    const transport = Object.assign(new EventEmitter(), {
      unref: vi.fn(),
      postMessage: vi.fn(() => {
        if (fault === 'post failure') {
          throw new Error('post failed')
        }
      }),
      terminate: vi.fn(async () => 1)
    })
    const value = client(() => transport)
    const pending = value.read(dir)
    if (fault === 'error') {
      transport.emit('error', new Error('worker failed'))
    }
    if (fault === 'exit') {
      transport.emit('exit', 1)
    }
    await expect(pending).resolves.toBeNull()
    expect(transport.terminate).toHaveBeenCalledTimes(1)
  })

  it('falls back under excess concurrent listing load', async () => {
    const transport = Object.assign(new EventEmitter(), {
      unref: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn(async () => 1)
    })
    const value = client(() => transport)
    const pending = Array.from({ length: 16 }, () => value.read(dir))
    await expect(value.read(dir)).resolves.toBeNull()
    expect(transport.postMessage).toHaveBeenCalledTimes(16)
    value.dispose()
    await expect(Promise.all(pending)).resolves.toEqual(Array(16).fill(null))
  })

  it('backs off until a timed-out worker exits and then allows a new worker', async () => {
    vi.useFakeTimers()
    const exited = Promise.withResolvers<number>()
    const transport = Object.assign(new EventEmitter(), {
      unref: vi.fn(),
      postMessage: vi.fn<(request: DetectionDirectoryRequest) => void>(),
      terminate: vi.fn(() => exited.promise)
    })
    const factory = vi.fn(() => transport)
    const value = client(factory)
    const first = value.read(dir)
    const second = value.read(path.join(dir, 'other'))
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    await expect(value.read(dir)).resolves.toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(transport.terminate).toHaveBeenCalledTimes(1)
    exited.resolve(1)
    await vi.advanceTimersByTimeAsync(0)
    const retry = value.read(dir)
    expect(factory).toHaveBeenCalledTimes(2)
    const request = transport.postMessage.mock.calls.at(-1)?.[0]
    transport.emit('message', { id: request?.id, names: new Map() })
    await expect(retry).resolves.toEqual(new Map())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(transport.terminate).toHaveBeenCalledTimes(2)
  })
})
