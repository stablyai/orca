import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

const connectionFields = {
  connectionId: z.string().nullish(),
  executionHostId: z.string().nullish()
}

export const newTabFolderWorkspaceListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'folderWorkspace.new-tab-host',
    method: 'folderWorkspace.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'folder-host-workspaces',
      z
        .object({
          folderWorkspaces: z.array(
            z.object({
              id: z.string(),
              folderPath: z.string(),
              projectGroupId: z.string(),
              ...connectionFields
            })
          )
        })
        .transform((result) => result.folderWorkspaces)
    )
  })
)

export const newTabFolderProjectGroupListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'projectGroup.new-tab-folder-host',
    method: 'projectGroup.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'folder-host-groups',
      z
        .object({
          groups: z.array(
            z.object({
              id: z.string(),
              parentGroupId: z
                .string()
                .nullish()
                .transform((value) => value ?? null),
              ...connectionFields
            })
          )
        })
        .transform((result) => result.groups)
    )
  })
)

export const newTabFolderRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.new-tab-folder-host',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'folder-host-repos',
      z
        .object({
          repos: z.array(
            z.object({
              path: z.string(),
              projectGroupId: z.string().nullish(),
              ...connectionFields
            })
          )
        })
        .transform((result) => result.repos)
    )
  })
)
