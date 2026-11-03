import { beforeEach, expect, it, vi } from 'vitest'

const { resumeRuntime, listRuntimes, recipeConnection } = vi.hoisted(() => ({
  resumeRuntime: vi.fn(),
  listRuntimes: vi.fn(),
  recipeConnection: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-workspace-resume-test') } }))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: listRuntimes,
  updateEphemeralVmRuntimeStatus: vi.fn()
}))
vi.mock('../../shared/ephemeral-vm-recipes', () => ({
  getEphemeralVmRecipeResultConnection: recipeConnection,
  getEphemeralVmRecipeResultPairingCode: vi.fn()
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  updateEnvironmentFromPairingCode: vi.fn()
}))
vi.mock('./runtime-service', () => ({ resumeEphemeralVmRuntime: resumeRuntime }))
vi.mock('./runtime-ssh', () => ({ connectRuntimeOwnedSshTarget: vi.fn() }))
vi.mock('../ipc/ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: vi.fn(() => ({
    repo: { repo: { path: '/repo' } },
    recipe: { id: 'recipe-1', name: 'Recipe', create: 'create' }
  }))
}))
vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn()
}))

import { resumeEphemeralVmWorkspace } from './workspace-resume'
import type { Store } from '../persistence'

const runtime = {
  id: 'runtime-1',
  workspaceId: 'ws-1',
  repoId: 'repo-1',
  status: 'suspended'
}

const store = {} as Store

beforeEach(() => {
  vi.clearAllMocks()
})

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

it('concurrent resumes for one workspace share a single recipe resume run', async () => {
  listRuntimes.mockReturnValue([{ ...runtime }])
  recipeConnection.mockReturnValue({ type: 'local' })
  const gate = deferred()
  resumeRuntime.mockImplementation(() => gate.promise)

  // Window IPC and the host wake can overlap before either writes a status; both must share the
  // in-flight resume instead of running the recipe resume twice for the same runtime.
  const first = resumeEphemeralVmWorkspace(store, 'ws-1')
  const second = resumeEphemeralVmWorkspace(store, 'ws-1')
  expect(resumeRuntime).toHaveBeenCalledTimes(1)
  const done = { ok: true, skipped: true, runtime: { ...runtime, status: 'running' } }
  gate.resolve(done)
  const [firstResult, secondResult] = await Promise.all([first, second])
  expect(resumeRuntime).toHaveBeenCalledTimes(1)
  expect(firstResult).toBe(secondResult)
})

it('a settled resume clears the in-flight entry so a later call runs again', async () => {
  listRuntimes.mockReturnValue([{ ...runtime }])
  recipeConnection.mockReturnValue({ type: 'local' })
  resumeRuntime.mockResolvedValue({
    ok: true,
    skipped: true,
    runtime: { ...runtime, status: 'running' }
  })

  await resumeEphemeralVmWorkspace(store, 'ws-1')
  await resumeEphemeralVmWorkspace(store, 'ws-1')

  expect(resumeRuntime).toHaveBeenCalledTimes(2)
})
