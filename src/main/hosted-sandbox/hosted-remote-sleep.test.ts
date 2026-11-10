import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockState = {
  records: Record<string, unknown>[]
  updates: { id: string; patch: Record<string, unknown> }[]
}
const state = vi.hoisted((): MockState => ({ records: [], updates: [] }))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => state.records,
  updateEphemeralVmRuntimeStatus: (_path: string, id: string, patch: Record<string, unknown>) => {
    state.updates.push({ id, patch })
    return { ...state.records.find((r) => r.id === id), ...patch }
  }
}))
vi.mock('./hosted-workspace-runtime', () => ({
  findCloudRuntime: (_path: string, workspaceId: string) =>
    workspaceId === 'ws' ? { runtime: state.records[0], sandboxId: 'sbx_1' } : null
}))
vi.mock('../environment-providers/environment-provider-recipe-adapter', () => ({
  environmentHandleFromRecipeResult: (result: { sandboxId: string }) => ({
    driverState: { sandboxId: result.sandboxId }
  })
}))
vi.mock('./hosted-sandbox-driver', () => ({ HOSTED_SANDBOX_DRIVER_ID: 'orca-cloud' }))

import {
  findCloudRuntimeBySandboxId,
  isAsleepOnControlPlane,
  markCloudRuntimeSleptElsewhere,
  noteCloudRuntimeRemoteState
} from './hosted-remote-sleep'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'

const RUNNING = {
  id: 'vm-1',
  status: 'running',
  updatedAt: 100,
  workspaceId: 'ws',
  recipe: { provider: 'orca-cloud' },
  recipeResult: { sandboxId: 'sbx_1' }
}
const record = (patch: Record<string, unknown> = {}): EphemeralVmRuntimeRecord =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the module under test reads only id, status, updatedAt and recipe.provider.
  ({ ...RUNNING, ...patch }) as unknown as EphemeralVmRuntimeRecord

describe('a cloud VM slept from another client', () => {
  beforeEach(() => {
    state.records = [{ ...RUNNING }]
    state.updates = []
  })

  it('marks the running record suspended so the row reads Asleep and the next wake resumes it', () => {
    expect(markCloudRuntimeSleptElsewhere('/u', record())?.status).toBe('suspended')
    expect(state.updates).toEqual([{ id: 'vm-1', patch: { status: 'suspended' } }])
  })

  it('leaves a record that changed while the control plane answered (a wake or sleep here wins)', () => {
    state.records = [{ ...RUNNING, updatedAt: 200 }]
    expect(markCloudRuntimeSleptElsewhere('/u', record())).toBeNull()
    state.records = [{ ...RUNNING, status: 'suspended' }]
    expect(markCloudRuntimeSleptElsewhere('/u', record())).toBeNull()
    expect(state.updates).toEqual([])
  })

  it('only touches running Orca Cloud records', () => {
    expect(markCloudRuntimeSleptElsewhere('/u', record({ status: 'suspended' }))).toBeNull()
    expect(
      markCloudRuntimeSleptElsewhere('/u', record({ recipe: { provider: 'other' } }))
    ).toBeNull()
    expect(state.updates).toEqual([])
  })

  it('asks the control plane; only a suspended sandbox counts, and an error counts as awake', async () => {
    const get = vi.fn()
    get.mockResolvedValueOnce({ status: 'suspended' })
    expect(await isAsleepOnControlPlane('/u', { get }, 'ws')).toBe(true)
    get.mockResolvedValueOnce({ status: 'suspending' })
    expect(await isAsleepOnControlPlane('/u', { get }, 'ws')).toBe(false)
    get.mockRejectedValueOnce(new Error('offline'))
    expect(await isAsleepOnControlPlane('/u', { get }, 'ws')).toBe(false)
    expect(await isAsleepOnControlPlane('/u', { get }, 'other')).toBe(false)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('a status read that says sleeping marks the record read before it, then resyncs sessions', () => {
    const syncSessions = vi.fn()
    const seen = findCloudRuntimeBySandboxId('/u', 'sbx_1')
    expect(seen?.id).toBe('vm-1')
    expect(findCloudRuntimeBySandboxId('/u', 'sbx_2')).toBeNull()
    noteCloudRuntimeRemoteState({ userDataPath: '/u', syncSessions }, seen!, 'ready')
    expect(syncSessions).not.toHaveBeenCalled()
    noteCloudRuntimeRemoteState({ userDataPath: '/u', syncSessions }, seen!, 'sleeping')
    expect(state.updates).toEqual([{ id: 'vm-1', patch: { status: 'suspended' } }])
    expect(syncSessions).toHaveBeenCalledTimes(1)
  })
})
