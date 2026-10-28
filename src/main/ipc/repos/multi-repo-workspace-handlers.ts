import { ipcMain } from 'electron'
import { MultiRepoWorkspaceError } from '../../../shared/multi-repo-workspace'
import {
  MultiRepoWorkspaceCreate,
  MultiRepoWorkspaceDelete,
  MultiRepoWorkspaceMemberSelector,
  MultiRepoWorkspaceSelector
} from '../../../shared/rpc-contract/multi-repo-workspace-params'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getMultiRepoWorkspaceService } from '../../runtime/multi-repo-workspace/multi-repo-workspace-runtime-port'
import { parseProjectGroupIpcArgs } from './repo-ipc-arg-schemas'

export const MULTI_REPO_WORKSPACE_IPC_CHANNELS = [
  'multiRepoWorkspaces:create',
  'multiRepoWorkspaces:retryMember',
  'multiRepoWorkspaces:removeMember',
  'multiRepoWorkspaces:detachMember',
  'multiRepoWorkspaces:attachMember',
  'multiRepoWorkspaces:inspectDelete',
  'multiRepoWorkspaces:delete'
] as const

/** IPC drops Error fields, so the typed code leads the message: `multi_repo_x: text`. */
async function withTypedErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof MultiRepoWorkspaceError) {
      throw new Error(`${error.code}: ${error.message}`)
    }
    throw error
  }
}

export function registerMultiRepoWorkspaceHandlers(runtime: OrcaRuntimeService): void {
  const service = getMultiRepoWorkspaceService(runtime)
  const parse = <T>(schema: Parameters<typeof parseProjectGroupIpcArgs<T>>[0], raw: unknown): T =>
    parseProjectGroupIpcArgs(schema, raw, 'invalid_multi_repo_workspace_args')

  ipcMain.handle('multiRepoWorkspaces:create', (_event, raw: unknown) =>
    withTypedErrors(async () => ({
      folderWorkspace: await service.create({
        ...parse(MultiRepoWorkspaceCreate, raw),
        creatorProvenance: { kind: 'host' }
      })
    }))
  )
  ipcMain.handle('multiRepoWorkspaces:retryMember', (_event, raw: unknown) =>
    withTypedErrors(async () => {
      const args = parse(MultiRepoWorkspaceMemberSelector, raw)
      return { folderWorkspace: await service.retryMember(args.folderWorkspaceId, args.memberId) }
    })
  )
  ipcMain.handle('multiRepoWorkspaces:removeMember', (_event, raw: unknown) =>
    withTypedErrors(async () => {
      const args = parse(MultiRepoWorkspaceMemberSelector, raw)
      return { folderWorkspace: await service.removeMember(args.folderWorkspaceId, args.memberId) }
    })
  )
  ipcMain.handle('multiRepoWorkspaces:detachMember', (_event, raw: unknown) =>
    withTypedErrors(async () => {
      const args = parse(MultiRepoWorkspaceMemberSelector, raw)
      return { folderWorkspace: await service.detachMember(args.folderWorkspaceId, args.memberId) }
    })
  )
  ipcMain.handle('multiRepoWorkspaces:attachMember', (_event, raw: unknown) =>
    withTypedErrors(async () => {
      const args = parse(MultiRepoWorkspaceMemberSelector, raw)
      return { folderWorkspace: await service.attachMember(args.folderWorkspaceId, args.memberId) }
    })
  )
  ipcMain.handle('multiRepoWorkspaces:inspectDelete', (_event, raw: unknown) =>
    withTypedErrors(() =>
      service.inspectDelete(parse(MultiRepoWorkspaceSelector, raw).folderWorkspaceId)
    )
  )
  ipcMain.handle('multiRepoWorkspaces:delete', (_event, raw: unknown) =>
    withTypedErrors(() => service.delete(parse(MultiRepoWorkspaceDelete, raw)))
  )
}
