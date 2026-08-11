import { describe, expect, it, vi } from 'vitest'
import {
  FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { REPO_METHODS } from './repo'

function makeRequest(method: string, params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('owner-qualified folder workspace deletion RPC', () => {
  it('advertises owner-qualified delete support', () => {
    expect(RUNTIME_CAPABILITIES).toContain(
      FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY
    )
  })

  it('forwards optional host owners into both runtime delete methods', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      deleteFolderWorkspace: vi.fn().mockResolvedValue({ deleted: true }),
      deleteProjectGroup: vi.fn().mockResolvedValue({ deleted: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const folderResponse = await dispatcher.dispatch(
      makeRequest('folderWorkspace.delete', {
        folderWorkspaceId: 'folder-workspace-1',
        executionHostId: 'ssh:ssh-target-1'
      })
    )
    const groupResponse = await dispatcher.dispatch(
      makeRequest('projectGroup.delete', {
        groupId: 'group-1',
        executionHostId: 'ssh:ssh-target-1',
        preserveRendererWorkspaceIds: ['folder-workspace-2']
      })
    )

    expect(runtime.deleteFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      executionHostId: 'ssh:ssh-target-1'
    })
    expect(runtime.deleteProjectGroup).toHaveBeenCalledWith('group-1', {
      executionHostId: 'ssh:ssh-target-1',
      preserveRendererWorkspaceIds: ['folder-workspace-2']
    })
    expect(folderResponse).toMatchObject({ ok: true, result: { deleted: true } })
    expect(groupResponse).toMatchObject({ ok: true, result: { deleted: true } })
  })
})
