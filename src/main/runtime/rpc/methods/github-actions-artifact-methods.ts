import { defineMethod } from '../core'
import {
  ActionsArtifacts,
  ActionsArtifactDownload,
  ActionsArtifactTransfer
} from '../../../../shared/rpc-contract/github-actions-artifact-params'
export const GITHUB_ACTIONS_ARTIFACT_METHODS = [
  defineMethod({
    name: 'github.actionsArtifacts',
    params: ActionsArtifacts,
    /** List artifacts on the execution host with caller cancellation propagated to GitHub reads. */
    handler: (params, { runtime, signal }) =>
      runtime.getRepoActionsArtifacts(params.repo, params, signal)
  }),
  defineMethod({
    name: 'github.startActionsArtifactDownload',
    params: ActionsArtifactDownload,
    /** Retain disconnect cancellation across chunk requests; dispose the lifetime immediately if acquisition fails. */
    handler: async (params, { runtime, signal, retainConnectionLifetime }) => {
      const lifetime = retainConnectionLifetime?.()
      let retained = false
      try {
        const transfer = await runtime.startRepoActionsArtifactDownload(
          params.repo,
          params,
          lifetime?.signal ?? signal,
          lifetime?.dispose
        )
        retained = true
        return transfer
      } finally {
        if (!retained) {
          lifetime?.dispose()
        }
      }
    }
  }),
  defineMethod({
    name: 'github.readActionsArtifactChunk',
    params: ActionsArtifactTransfer,
    /** Revalidate execution-host transfer ownership before returning a bounded archive chunk. */
    handler: (params, { runtime }) => runtime.readRepoActionsArtifactChunk(params.repo, params)
  }),
  defineMethod({
    name: 'github.releaseActionsArtifactDownload',
    params: ActionsArtifactTransfer,
    /** Release the owner-matching archive and its retained disconnect lifetime. */
    handler: (params, { runtime }) =>
      runtime.releaseRepoActionsArtifactDownload(params.repo, params)
  })
]
