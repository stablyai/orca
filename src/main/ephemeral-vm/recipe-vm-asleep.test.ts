import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'

type VmRow = Partial<EphemeralVmRuntimeRecord>
type MockState = { runtimes: VmRow[]; environmentVm: (VmRow & { workspaceId: string }) | null }

const mocks = vi.hoisted((): MockState => ({ runtimes: [], environmentVm: null }))

vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => mocks.runtimes
}))
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: (_root: string, id: string) => ({ id })
}))
vi.mock('../../shared/ephemeral-vm-environment-sleep', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findEnvironmentEphemeralVmRuntime: () => mocks.environmentVm ?? undefined
}))

import { isRecipeVmEnvironmentAsleep, isRecipeVmSshTargetAsleep } from './recipe-vm-asleep'
import {
  registerRecipeVmWaker,
  type RecipeVmWaker
} from '../runtime/workspaces/sleep/recipe-vm-waker-registry'
import type { RecipeVmState } from '../runtime/workspaces/sleep/recipe-vm-operations'

function waker(state: (recordSuspended: boolean) => RecipeVmState): RecipeVmWaker {
  return {
    state: (_workspaceId, recordSuspended) => state(recordSuspended),
    noteOpened: vi.fn(),
    holdOpen: vi.fn(),
    openEnvironment: vi.fn()
  }
}

afterEach(() => {
  registerRecipeVmWaker(null)
  mocks.runtimes = []
  mocks.environmentVm = null
})

describe('recipe VM asleep predicate', () => {
  it('holds a suspended VM until its wake is under way', () => {
    mocks.environmentVm = { id: 'vm-1', workspaceId: 'ws-1', status: 'suspended' }
    let waking = false
    registerRecipeVmWaker(waker((suspended) => (waking ? 'waking' : suspended ? 'asleep' : 'up')))

    expect(isRecipeVmEnvironmentAsleep('/data', 'env-1')).toBe(true)
    waking = true
    expect(isRecipeVmEnvironmentAsleep('/data', 'env-1')).toBe(false)
  })

  it('never holds a running VM or an environment no VM serves', () => {
    registerRecipeVmWaker(waker((suspended) => (suspended ? 'asleep' : 'up')))
    expect(isRecipeVmEnvironmentAsleep('/data', 'env-1')).toBe(false)
    mocks.environmentVm = { id: 'vm-1', workspaceId: 'ws-1', status: 'running' }
    expect(isRecipeVmEnvironmentAsleep('/data', 'env-1')).toBe(false)
  })

  it('does not hold a VM whose suspend is still running: a failed suspend leaves it up', () => {
    mocks.environmentVm = { id: 'vm-1', workspaceId: 'ws-1', status: 'running' }
    registerRecipeVmWaker(waker(() => 'asleep'))
    expect(isRecipeVmEnvironmentAsleep('/data', 'env-1')).toBe(false)
  })

  it('reads the stored record on a host with no waker', () => {
    mocks.environmentVm = { id: 'vm-1', workspaceId: 'ws-1', status: 'resume_failed' }
    expect(isRecipeVmEnvironmentAsleep('/data', 'env-1')).toBe(true)
  })

  it('matches a VM to its Orca-owned SSH host and skips every other host', () => {
    registerRecipeVmWaker(waker((suspended) => (suspended ? 'asleep' : 'up')))
    mocks.runtimes = [
      { id: 'vm-1', workspaceId: 'ws-1', status: 'suspended' },
      { id: 'vm-2', workspaceId: 'ws-2', status: 'running', sshTargetId: 'runtime-ssh-vm-2' },
      { id: 'vm-3', workspaceId: 'ws-3', status: 'cleaned' }
    ]
    expect(isRecipeVmSshTargetAsleep('/data', 'runtime-ssh-vm-1')).toBe(true)
    expect(isRecipeVmSshTargetAsleep('/data', 'runtime-ssh-vm-2')).toBe(false)
    expect(isRecipeVmSshTargetAsleep('/data', 'runtime-ssh-vm-3')).toBe(false)
    expect(isRecipeVmSshTargetAsleep('/data', 'my-own-host')).toBe(false)
  })
})
