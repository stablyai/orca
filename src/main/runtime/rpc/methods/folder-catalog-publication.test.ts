import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { REPO_METHODS } from './repo'

function request(method: string, params?: unknown): RpcRequest {
  return { id: `${method}-request`, authToken: 'token', method, params }
}

describe('folder catalog RPC publication', () => {
  it('omits ambiguous IDs for legacy clients and returns all owner-qualified rows on request', async () => {
    const sharedGroup = { id: 'shared-group', connectionId: null }
    const sharedFolder = {
      id: 'shared-folder',
      projectGroupId: 'shared-group',
      connectionId: null
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listProjectGroups: () => [
        sharedGroup,
        { ...sharedGroup, connectionId: 'ssh-1' },
        { id: 'unique-group', connectionId: null },
        { id: 'invalid-group', connectionId: null, executionHostId: 'ssh:ssh-1' }
      ],
      listFolderWorkspaces: () => [
        sharedFolder,
        { ...sharedFolder, connectionId: 'ssh-1' },
        { id: 'dependent-folder', projectGroupId: 'shared-group' },
        { id: 'unique-folder', projectGroupId: 'unique-group', connectionId: null },
        { id: 'invalid-folder', projectGroupId: 'invalid-group' }
      ]
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    await expect(dispatcher.dispatch(request('projectGroup.list'))).resolves.toMatchObject({
      ok: true,
      result: { groups: [{ id: 'unique-group' }] }
    })
    await expect(dispatcher.dispatch(request('folderWorkspace.list'))).resolves.toMatchObject({
      ok: true,
      result: { folderWorkspaces: [{ id: 'unique-folder' }] }
    })
    await expect(
      dispatcher.dispatch(request('projectGroup.list', { ownerQualified: true }))
    ).resolves.toMatchObject({
      ok: true,
      result: {
        groups: [
          { id: 'shared-group' },
          { id: 'shared-group' },
          { id: 'unique-group' },
          { id: 'invalid-group' }
        ]
      }
    })
    await expect(
      dispatcher.dispatch(request('folderWorkspace.list', { ownerQualified: true }))
    ).resolves.toMatchObject({
      ok: true,
      result: {
        folderWorkspaces: [
          { id: 'shared-folder' },
          { id: 'shared-folder' },
          { id: 'dependent-folder' },
          { id: 'unique-folder' },
          { id: 'invalid-folder' }
        ]
      }
    })
  })

  it('keeps the additive request compatible with legacy null-schema handlers', async () => {
    const runtime = { getRuntimeId: () => 'legacy-runtime' } as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'legacy.folderWorkspace.list',
          params: null,
          handler: () => ({ folderWorkspaces: [{ id: 'legacy-folder' }] })
        })
      ]
    })

    await expect(
      dispatcher.dispatch(request('legacy.folderWorkspace.list', { ownerQualified: true }))
    ).resolves.toMatchObject({
      ok: true,
      result: { folderWorkspaces: [{ id: 'legacy-folder' }] }
    })
  })
})
