import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  ActionsArtifactsQuery,
  ActionsArtifactDownloadQuery,
  ActionsArtifactTransferQuery
} from '../../shared/rpc-contract/github-actions-artifact-params'
import type { ActionsRequestContext } from '../../shared/github/actions-types'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { registeredActionsRepo } from './github-actions-repo-routing'
import { getGitHubLocalGitOptionArgs } from './github-repo-routing'
import {
  listActionsArtifacts,
  startActionsArtifactDownload
} from '../github/client/actions/actions-artifacts'
import {
  artifactSessionOwner,
  readArtifactSession,
  releaseArtifactSession
} from '../github/client/actions/artifact-download-sessions'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
/** Register owner-checked chunk transfers and retain renderer cleanup until the archive session ends. */
export function registerGitHubActionsArtifactHandlers(store: Store): void {
  ipcMain.handle('gh:actionsArtifacts', (_event, args: ActionsRequestContext) => {
    const query = ActionsArtifactsQuery.parse(args)
    const repo = registeredActionsRepo(args, store)
    return listActionsArtifacts(
      repo.path,
      query,
      getRepoSshConnectionId(repo),
      ...getGitHubLocalGitOptionArgs(store, repo)
    )
  })
  ipcMain.handle('gh:startActionsArtifactDownload', async (event, args: ActionsRequestContext) => {
    const query = ActionsArtifactDownloadQuery.parse(args)
    const repo = registeredActionsRepo(args, store)
    const lifetime = abortWhenRendererGone(event.sender)
    let retained = false
    try {
      const transfer = await startActionsArtifactDownload(
        repo.path,
        query,
        getRepoSshConnectionId(repo),
        getGitHubLocalGitOptionArgs(store, repo)[0],
        lifetime.signal,
        lifetime.dispose
      )
      retained = true
      return transfer
    } finally {
      if (!retained) {
        lifetime.dispose()
      }
    }
  })
  ipcMain.handle('gh:readActionsArtifactChunk', (_event, args: ActionsRequestContext) => {
    const query = ActionsArtifactTransferQuery.parse(args)
    const repo = registeredActionsRepo(args, store)
    return readArtifactSession(
      query.transferId,
      artifactSessionOwner(
        repo.path,
        getRepoSshConnectionId(repo),
        getGitHubLocalGitOptionArgs(store, repo)[0]
      ),
      query.offset ?? 0
    )
  })
  ipcMain.handle('gh:releaseActionsArtifactDownload', (_event, args: ActionsRequestContext) => {
    const query = ActionsArtifactTransferQuery.parse(args)
    const repo = registeredActionsRepo(args, store)
    releaseArtifactSession(
      query.transferId,
      artifactSessionOwner(
        repo.path,
        getRepoSshConnectionId(repo),
        getGitHubLocalGitOptionArgs(store, repo)[0]
      )
    )
  })
}
