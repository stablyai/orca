import { describe, expect, it } from 'vitest'
import { EphemeralVmRuntimeRecordSchema } from './ephemeral-vm-runtimes'

// TASK-BE-EVM-010's round-trip check, mirrored on the frontend: a fixture
// matching exactly what backend-go's toEphemeralVmRuntimeView
// (backend-go/services/api-gateway/internal/adapter/wscompat/
// channels_ephemeral_vm.go) sends over the wire for
// listRuntimes/attachWorkspace/suspendWorkspace/resumeWorkspace/cleanup
// must decode without error. Field names/values below are kept in sync with
// that function's Go test, TestToEphemeralVmRuntimeView_
// IncludesAllFrontendRequiredFields.
describe('EphemeralVmRuntimeRecordSchema — backend-go wire shape round-trip', () => {
  it('decodes a fully-populated infra-fleet-service-backed runtime', () => {
    const wireResponse = {
      id: 'rt-1',
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      status: 'running', // backend "active" remapped to frontend "running"
      workspaceId: 'ws-1',
      lastError: '',
      createdAt: 1_756_728_000_000,
      updatedAt: 1_757_320_200_000,
      connectionMode: 'orca-server',
      runtimeEnvironmentId: 'env-1'
      // cleanupStatus/recipeResult intentionally absent — backend-go has no
      // source data for either (TASK-BE-EVM-010), so both must be optional.
    }

    const result = EphemeralVmRuntimeRecordSchema.safeParse(wireResponse)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cleanupStatus).toBeUndefined()
      expect(result.data.recipeResult).toBeUndefined()
      expect(result.data.connectionMode).toBe('orca-server')
      expect(result.data.runtimeEnvironmentId).toBe('env-1')
    }
  })

  it('decodes a never-attached, pre-pairing runtime (connectionMode/runtimeEnvironmentId/workspaceId omitted)', () => {
    const wireResponse = {
      id: 'rt-2',
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      status: 'provisioning',
      lastError: '',
      createdAt: 1_756_728_000_000,
      updatedAt: 1_756_728_000_000
    }

    const result = EphemeralVmRuntimeRecordSchema.safeParse(wireResponse)

    expect(result.success).toBe(true)
  })

  it('decodes a destroyed runtime with cleanupStatus "succeeded" (the one derivable case)', () => {
    const wireResponse = {
      id: 'rt-3',
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      status: 'cleaned', // backend "destroyed" remapped to frontend "cleaned"
      cleanupStatus: 'succeeded',
      lastError: '',
      createdAt: 1_756_728_000_000,
      updatedAt: 1_756_728_100_000
    }

    const result = EphemeralVmRuntimeRecordSchema.safeParse(wireResponse)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cleanupStatus).toBe('succeeded')
    }
  })
})
