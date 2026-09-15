import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Store } from '../persistence'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
const mocks = vi.hoisted(() => ({
  path: vi.fn(),
  handle: vi.fn(),
  resume: vi.fn(),
  suspend: vi.fn(),
  cleanup: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn()
}))
vi.mock('../persistence', () => ({ Store: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: mocks.path },
  ipcMain: { handle: mocks.handle, removeHandler: vi.fn() }
}))
vi.mock('../ephemeral-vm-runtime-service', () => ({
  resumeEphemeralVmRuntime: mocks.resume,
  suspendEphemeralVmRuntime: mocks.suspend,
  cleanupEphemeralVmRuntime: mocks.cleanup,
  stopEphemeralVmRuntimeCleanup: vi.fn()
}))
vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: mocks.connect,
  disconnectRuntimeOwnedSshTarget: mocks.disconnect,
  removeRuntimeOwnedSshTarget: mocks.remove
}))
vi.mock('./runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: mocks.invalidate
}))
vi.mock('./ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: () => ({ repo: { repo: { path: '/fixture' } }, recipe: {} })
}))
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../shared/runtime-environment-store'
import { encodePairingOffer } from '../../shared/pairing'
import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'
let directory: string
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const call = (name: string) =>
  handlers.get(`ephemeralVm:${name}`)!(
    null,
    name === 'cleanup' ? { runtimeId: 'runtime' } : { workspaceId: 'workspace' }
  )
const current = () => listEphemeralVmRuntimes(directory)[0]
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  directory = mkdtempSync(join(tmpdir(), 'orca-lifecycle-race-'))
  mocks.path.mockReturnValue(directory)
  mocks.handle.mockImplementation((name, fn) => handlers.set(name, fn))
  upsertEphemeralVmRuntime(directory, {
    id: 'runtime',
    repoId: 'repo',
    recipeId: 'recipe',
    workspaceId: 'workspace',
    status: 'suspended',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/fixture',
        target: { label: 'VM', host: 'host', username: 'orca', port: 22 }
      }
    }
  })
  mocks.resume.mockImplementation(async () => ({
    ok: true,
    skipped: false,
    runtime: updateEphemeralVmRuntimeStatus(directory, 'runtime', { status: 'running' })
  }))
  mocks.suspend.mockImplementation(async () => ({
    ok: true,
    skipped: false,
    runtime: updateEphemeralVmRuntimeStatus(directory, 'runtime', { status: 'suspended' })
  }))
  mocks.cleanup.mockImplementation(async () => ({
    ok: true,
    skipped: false,
    runtime: updateEphemeralVmRuntimeStatus(directory, 'runtime', {
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })
  }))
  mocks.connect.mockResolvedValue({ targetId: 'ssh' })
  mocks.disconnect.mockResolvedValue(undefined)
  mocks.remove.mockResolvedValue(undefined)
  registerEphemeralVmRuntimeHandlers(new Store())
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
it('rejects overlapping actions through SSH registration and permits a later cleanup', async () => {
  const gate = barrier()
  mocks.connect.mockImplementation(async () => {
    await gate.promise
    return { targetId: 'ssh' }
  })
  const first = call('resumeWorkspace')
  await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce())
  await expect(call('resumeWorkspace')).rejects.toThrow('already in progress')
  await expect(call('cleanup')).rejects.toThrow('already in progress')
  await expect(call('suspendWorkspace')).rejects.toThrow('already in progress')
  expect(mocks.cleanup).not.toHaveBeenCalled()
  expect(mocks.suspend).not.toHaveBeenCalled()
  gate.release()
  await first
  await call('cleanup')
  expect(mocks.resume).toHaveBeenCalledOnce()
  expect(mocks.connect).toHaveBeenCalledOnce()
  expect(mocks.remove).toHaveBeenCalledWith('ssh')
  expect(current().status).toBe('cleaned')
})
it('rejects resume during cleanup and never revives a cleaned runtime', async () => {
  const gate = barrier()
  mocks.cleanup.mockImplementation(async () => {
    await gate.promise
    return {
      ok: true,
      runtime: updateEphemeralVmRuntimeStatus(directory, 'runtime', {
        status: 'cleaned',
        cleanupStatus: 'succeeded'
      })
    }
  })
  const cleanup = call('cleanup')
  await vi.waitFor(() => expect(mocks.cleanup).toHaveBeenCalledOnce())
  await expect(call('resumeWorkspace')).rejects.toThrow('already in progress')
  gate.release()
  await cleanup
  await expect(call('resumeWorkspace')).resolves.toBeNull()
  expect(mocks.resume).not.toHaveBeenCalled()
})
it('permits suspend after the admitted resume including its SSH registration settles', async () => {
  await call('resumeWorkspace')
  await call('suspendWorkspace')
  expect(mocks.disconnect).toHaveBeenCalledWith('ssh')
  expect(current().status).toBe('suspended')
})
it('allows cleanup after a failed resume without retaining the operation gate', async () => {
  mocks.connect.mockRejectedValueOnce(new Error('SSH failed'))
  await expect(call('resumeWorkspace')).rejects.toThrow('SSH failed')
  await call('cleanup')
  expect(current().status).toBe('cleaned')
})

it('repairs stale local pairing after a provider resume was persisted before a desktop crash', async () => {
  const offer = {
    v: 2 as const,
    endpoint: 'wss://old.example.com',
    deviceToken: 'old-token',
    publicKeyB64: 'public-key'
  }
  const environment = addEnvironmentFromPairingCode(directory, {
    name: 'cloud',
    pairingCode: encodePairingOffer(offer)
  })
  const fresh = encodePairingOffer({
    ...offer,
    endpoint: 'wss://resumed.example.com',
    deviceToken: 'new-token'
  })
  updateEphemeralVmRuntimeStatus(directory, 'runtime', {
    status: 'running',
    connectionMode: 'orca-server',
    runtimeEnvironmentId: environment.id,
    recipeResult: { schemaVersion: 1, pairingCode: fresh, projectRoot: '/fixture' }
  })
  await call('resumeWorkspace')
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(listEnvironments(directory)[0].endpoints[0]).toMatchObject({
    endpoint: 'wss://resumed.example.com',
    deviceToken: 'new-token'
  })
  expect(mocks.invalidate).toHaveBeenCalledOnce()
  const revision = listEnvironments(directory)[0].pairingRevision
  await call('resumeWorkspace')
  expect(mocks.invalidate).toHaveBeenCalledOnce()
  expect(listEnvironments(directory)[0].pairingRevision).toBe(revision)
})
