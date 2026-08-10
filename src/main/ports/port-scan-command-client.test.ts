import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALL_DEADLINE_MS,
  MAX_QUEUED_CALLS,
  PortScanCommandClient,
  isPortScanWorkerUnavailableError,
  resolveWorkerEntryPath
} from './port-scan-command-client'
import {
  PortScanCommandTimeoutError,
  type PortScanCommandRequest
} from './port-scan-command-protocol'

type PortScanCommandResponseBody =
  | { ok: true; stdout: string; spawnMs: number }
  | { ok: false; timedOut: boolean; error: string }

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

// A worker_threads stand-in the tests drive directly: it records posted requests
// and lets a test emit message/error/exit without a built worker bundle.
class FakeWorker {
  postedRequests: PortScanCommandRequest[] = []
  terminated = false
  private listeners = new Map<string, Set<(arg?: unknown) => void>>()

  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (arg?: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: PortScanCommandRequest): void {
    this.postedRequests.push(request)
  }

  emit(event: string, arg?: unknown): void {
    // Copy first: the client removes its listeners synchronously during a fault.
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  respond(body: PortScanCommandResponseBody): void {
    const last = this.postedRequests.at(-1)
    if (!last) {
      throw new Error('no request posted to fake worker')
    }
    this.emit('message', { id: last.id, ...body })
  }
}

function makeFactory(workers: FakeWorker[]): () => Worker {
  return () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }
}

function makeClient(workers: FakeWorker[]): PortScanCommandClient {
  return new PortScanCommandClient({ workerFactory: makeFactory(workers), log() {} })
}

describe('PortScanCommandClient', () => {
  afterEach(() => {
    vi.useRealTimers()
    execFileMock.mockReset()
  })

  it('dispatches one command at a time so a stalled spawn cannot fan out', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const first = client.run('lsof', ['-nP'])
    const second = client.run('ps', ['-p', '1'])
    await Promise.resolve()

    // Why (#11161): a second in-flight request would have its deadline armed
    // while the worker's loop is still blocked inside the first uv_spawn.
    expect(workers[0].postedRequests.map((request) => request.command)).toEqual(['lsof'])

    workers[0].respond({ ok: true, stdout: 'lsof-out', spawnMs: 12 })
    await expect(first).resolves.toEqual({ stdout: 'lsof-out', spawnMs: 12 })
    expect(workers[0].postedRequests.map((request) => request.command)).toEqual(['lsof', 'ps'])

    workers[0].respond({ ok: true, stdout: 'ps-out', spawnMs: 9 })
    await expect(second).resolves.toEqual({ stdout: 'ps-out', spawnMs: 9 })
  })

  it('ignores responses that do not correlate with the active request', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const pending = client.run('lsof', [])
    await Promise.resolve()
    workers[0].emit('message', { id: 999, ok: true, stdout: 'stale', spawnMs: 1 })
    workers[0].respond({ ok: true, stdout: 'fresh', spawnMs: 3 })

    await expect(pending).resolves.toMatchObject({ stdout: 'fresh' })
  })

  it('rehydrates a worker-side command timeout so the scan can back off', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const pending = client.run('lsof', [])
    await Promise.resolve()
    workers[0].respond({ ok: false, timedOut: true, error: 'lsof timed out after 4000ms' })

    await expect(pending).rejects.toBeInstanceOf(PortScanCommandTimeoutError)
  })

  it('reports a worker crash as a non-timeout error and respawns for the next call', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const pending = client.run('lsof', [])
    await Promise.resolve()
    workers[0].emit('error', new Error('worker blew up'))

    const error = await pending.catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PortScanCommandTimeoutError)
    expect(workers[0].terminated).toBe(true)

    const next = client.run('ps', [])
    await Promise.resolve()
    expect(workers).toHaveLength(2)
    workers[1].respond({ ok: true, stdout: 'ps-out', spawnMs: 2 })
    await expect(next).resolves.toMatchObject({ stdout: 'ps-out' })
  })

  it('terminates a silent worker at the call deadline without arming the backoff', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const pending = client.run('netstat', ['-ano'])
    const settled = pending.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS)

    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PortScanCommandTimeoutError)
    expect(workers[0].terminated).toBe(true)
  })

  it('rejects overflow instead of growing the queue without bound', async () => {
    const workers: FakeWorker[] = []
    const client = makeClient(workers)

    const accepted = Array.from({ length: MAX_QUEUED_CALLS + 1 }, () => client.run('lsof', []))
    const overflow = client.run('lsof', [])

    const error = await overflow.catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PortScanCommandTimeoutError)

    for (let i = 0; i < accepted.length; i++) {
      workers[0].respond({ ok: true, stdout: 'drained', spawnMs: 1 })
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(MAX_QUEUED_CALLS + 1)
  })

  it('fails closed instead of spawning the command on this thread', async () => {
    const client = new PortScanCommandClient({
      workerFactory: () => {
        throw new Error('worker entry not found')
      },
      log() {}
    })

    const error = await client.run('lsof', []).catch((err: unknown) => err)

    expect(isPortScanWorkerUnavailableError(error)).toBe(true)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

// Why: the packaged branch never runs in dev or e2e (both take the __dirname
// path), so it is pinned here at the path-construction level. Whether Electron's
// asar shim can load a Worker entry from inside app.asar is not testable here —
// that still needs a packaged smoke test.
describe('resolveWorkerEntryPath', () => {
  const WORKER_ENTRY_FILENAME = 'port-scan-command-worker-entry.js'

  it('resolves a packaged build under resourcesPath/app.asar/out/main', () => {
    const resourcesPath = join(sep, 'Applications', 'Orca.app', 'Contents', 'Resources')

    const resolved = resolveWorkerEntryPath({
      isPackaged: true,
      resourcesPath,
      moduleDir: join(sep, 'unpackaged', 'out', 'main')
    })

    expect(resolved.startsWith(`${resourcesPath}${sep}`)).toBe(true)
    expect(resolved.slice(resourcesPath.length + 1).split(sep)).toEqual([
      'app.asar',
      'out',
      'main',
      WORKER_ENTRY_FILENAME
    ])
  })

  it('ignores resourcesPath when the app is not packaged', () => {
    const moduleDir = join(sep, 'repo', 'out', 'main')

    const resolved = resolveWorkerEntryPath({
      isPackaged: false,
      resourcesPath: join(sep, 'Applications', 'Orca.app', 'Contents', 'Resources'),
      moduleDir
    })

    expect(resolved).toBe(join(moduleDir, WORKER_ENTRY_FILENAME))
    expect(resolved).not.toContain('app.asar')
  })

  // A rename in the build config would leave both branches pointing at a file
  // that is never emitted, and only the packaged one fails silently.
  it('names the entry the main build actually emits', () => {
    const config = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'electron.vite.config.ts'),
      'utf8'
    )

    expect(config).toContain("'port-scan-command-worker-entry': resolve(")
  })
})

const REAL_WORKER_BLOCK_MS = 800

// Mirrors the worker entry's protocol but blocks its own thread first, standing
// in for the endpoint-security hook that makes CreateProcessW take seconds.
const BLOCKING_WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads')
const { execFile } = require('node:child_process')
parentPort.on('message', (request) => {
  const startedAt = Date.now()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${REAL_WORKER_BLOCK_MS})
  execFile(process.execPath, ['-e', ''], () => {
    parentPort.postMessage({
      id: request.id,
      ok: true,
      stdout: 'ok',
      spawnMs: Date.now() - startedAt
    })
  })
})
`

describe('PortScanCommandClient on a real worker thread', () => {
  it('keeps the calling event loop responsive while a spawn stalls', async () => {
    const client = new PortScanCommandClient({
      workerFactory: () => new Worker(BLOCKING_WORKER_SCRIPT, { eval: true }),
      log() {}
    })

    let last = Date.now()
    let maxStallMs = 0
    const probe = setInterval(() => {
      const now = Date.now()
      maxStallMs = Math.max(maxStallMs, now - last - 10)
      last = now
    }, 10)
    try {
      const results = await Promise.all([client.run('lsof', []), client.run('ps', [])])

      expect(results.map((result) => result.stdout)).toEqual(['ok', 'ok'])
      expect(results[0].spawnMs).toBeGreaterThanOrEqual(REAL_WORKER_BLOCK_MS - 100)
      expect(maxStallMs).toBeLessThan(400)
    } finally {
      clearInterval(probe)
    }
  }, 30_000)
})
