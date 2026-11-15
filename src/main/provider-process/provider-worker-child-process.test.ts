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
})
