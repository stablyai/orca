import type * as ProcessHostModule from '@orca/process-host'
import type { WorkerThreadChildRequest } from '../worker-thread-child-process/worker-thread-child-process-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { workerSpawn, mainSpawn } = vi.hoisted(() => ({
  workerSpawn: vi.fn(),
  mainSpawn: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHostModule>()),
  spawnProcess: mainSpawn
}))
vi.mock('./provider-worker-thread-host', () => ({
  spawnProcessOnProviderWorkerThread: workerSpawn,
  canSpawnOnProviderWorkerThread: () => true
}))

import { WorkerThreadChildProcess } from '../worker-thread-child-process/worker-thread-child-process'
import { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { awaitProviderChildSpawn } from './provider-child'
import { resolveProviderSpawner } from './provider-worker-child-process'

let requests: WorkerThreadChildRequest[]
let child: WorkerThreadChildProcess
const hostPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  requests = []
  mainSpawn.mockReset()
  workerSpawn.mockReset().mockImplementation(() => {
    child = new WorkerThreadChildProcess(3, (request) => {
      requests.push(request)
      return true
    })
    return child
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
})

const output = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('agent launches on the Windows provider worker', () => {
  it('runs a model listing on the worker without creating the agent on main', async () => {
    const listing = runAgentModelCatalogListing(
      { command: 'claude', args: ['--print'], stdin: 'list models\n' },
      { site: 'claude-model-catalog-probe', platform: 'win32', inheritedEnv: {} }
    )

    expect(workerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'claude', args: ['--print'] })
    )
    expect(mainSpawn).not.toHaveBeenCalled()
    child.receive({ type: 'spawn', id: 3, pid: 4141 })
    child.receive({ type: 'stdout', id: 3, chunk: output('{"models":') })
    child.receive({ type: 'stdout', id: 3, chunk: output('[]}\n') })
    child.receive({ type: 'exit', id: 3, code: 0, signal: null })
    child.receive({ type: 'close', id: 3, code: 0, signal: null })

    await expect(listing).resolves.toBe('{"models":[]}\n')
    expect(requests).toContainEqual({ type: 'stdin-write', id: 3, data: 'list models\n' })
    expect(requests).toContainEqual({ type: 'stdin-end', id: 3 })
  })

  it('knows the agent pid once the worker reports the spawn', async () => {
    const managed = spawnManagedProviderProcess(
      { command: 'claude', args: [] },
      { site: 'claude-structured-session', platform: 'win32', inheritedEnv: {} }
    )
    const pid = awaitProviderChildSpawn(managed.child).then(() => managed.child.pid)
    // The worker reports the spawn after the launch call returns.
    await new Promise((resolve) => setImmediate(resolve))
    child.receive({ type: 'spawn', id: 3, pid: 4141 })

    await expect(pid).resolves.toBe(4141)
    child.receive({ type: 'exit', id: 3, code: 0, signal: null })
    child.receive({ type: 'close', id: 3, code: 0, signal: null })
    await managed.exitPromise
  })

  it('reports a listing whose agent could not start on the worker as a spawn failure', async () => {
    const listing = runAgentModelCatalogListing(
      { command: 'claude', args: [] },
      { site: 'claude-model-catalog-probe', platform: 'win32', inheritedEnv: {} }
    )

    child.receive({
      type: 'spawn-error',
      id: 3,
      error: { message: 'spawn claude ENOENT', code: 'ENOENT' }
    })

    await expect(listing).rejects.toMatchObject({ reason: 'spawn' })
  })

  it('closes a child whose reader paused stdout with output still buffered', async () => {
    const agent = resolveProviderSpawner(undefined)!({ program: 'claude', args: [] })
    let text = ''
    agent.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      agent.stdout!.pause()
    })
    let closed = false
    agent.on('close', () => {
      closed = true
    })
    child.receive({ type: 'spawn', id: 3, pid: 4141 })
    child.receive({ type: 'stdout', id: 3, chunk: output('first-') })
    await vi.waitFor(() => expect(text).toBe('first-'))
    child.receive({ type: 'stdout', id: 3, chunk: output('second') })
    child.receive({ type: 'exit', id: 3, code: 0, signal: null })
    child.receive({ type: 'close', id: 3, code: 0, signal: null })

    await vi.waitFor(() => expect(closed).toBe(true))
    expect(text).toBe('first-second')
  })

  it('credits the worker for output only once the reader has room for it', async () => {
    const agent = resolveProviderSpawner(undefined)!({ program: 'claude', args: [] })
    const credits = (): number[] =>
      requests.flatMap((request) => (request.type === 'output-consumed' ? [request.bytes] : []))
    child.receive({ type: 'spawn', id: 3, pid: 4141 })

    child.receive({ type: 'stdout', id: 3, chunk: new Uint8Array(64 * 1024) })
    child.receive({ type: 'stdout', id: 3, chunk: new Uint8Array(1024) })
    expect(credits()).toEqual([])

    agent.stdout!.resume()
    await vi.waitFor(() => expect(credits()).toEqual([65 * 1024]))
  })

  it('stops holding the worker for a reader that destroyed its stream', async () => {
    const agent = resolveProviderSpawner(undefined)!({ program: 'claude', args: [] })
    child.receive({ type: 'spawn', id: 3, pid: 4141 })
    child.receive({ type: 'stdout', id: 3, chunk: new Uint8Array(64 * 1024) })

    agent.stdout!.destroy()
    child.receive({ type: 'stdout', id: 3, chunk: new Uint8Array(1024) })

    await vi.waitFor(() =>
      expect(requests).toContainEqual({ type: 'discard-output', id: 3, stream: 'stdout' })
    )
    expect(requests).toContainEqual({ type: 'output-consumed', id: 3, bytes: 64 * 1024 })
    expect(requests).toContainEqual({ type: 'output-consumed', id: 3, bytes: 1024 })
  })
})
