import { defineMethod } from '../core'
import { remoteFileContentBudget } from './files-remote-content-budget'
import {
  TerminalArtifactFile,
  TerminalArtifactFileWrite
} from '../../../../shared/rpc-contract/files-terminal-artifact-params'
import { TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES } from '../../../../shared/runtime-file-contracts'
import { remoteRpcResultExceedsContentBudget } from '../../../../shared/remote-rpc-content-budget'
import { PREVIEW_CONTENT_FIELDS } from '../../files/file-preview-budget'

/** Desktop clients read and save a granted file as large as a workspace one; phones and in-process callers keep 512 KB. */
function grantTextMaxBytes(clientKind: 'mobile' | 'runtime' | undefined): number | undefined {
  return clientKind === 'runtime' ? TERMINAL_ARTIFACT_DESKTOP_MAX_BYTES : undefined
}

export const FILE_TERMINAL_ARTIFACT_METHODS = [
  defineMethod({
    name: 'files.readTerminalArtifact',
    permission: 'workspace',
    params: TerminalArtifactFile,
    handler: async (params, { runtime, clientId, clientKind, requestId }) => {
      const result = await runtime.readTerminalArtifactFile(
        params.worktree,
        params.grantId,
        params.absolutePath,
        clientId,
        grantTextMaxBytes(clientKind)
      )
      const budget = remoteFileContentBudget(clientKind, requestId)
      // Why: escaping can grow text past one reply; a typed refusal beats a dropped reply.
      if (
        budget !== undefined &&
        remoteRpcResultExceedsContentBudget(result, budget, PREVIEW_CONTENT_FIELDS)
      ) {
        throw new Error('file_too_large')
      }
      return result
    }
  }),
  defineMethod({
    name: 'files.readTerminalArtifactPreview',
    permission: 'workspace',
    params: TerminalArtifactFile,
    handler: async (params, { runtime, clientId, clientKind, requestId }) => {
      const budget = remoteFileContentBudget(clientKind, requestId)
      return budget === undefined
        ? runtime.readTerminalArtifactPreview(
            params.worktree,
            params.grantId,
            params.absolutePath,
            clientId
          )
        : runtime.readTerminalArtifactPreview(
            params.worktree,
            params.grantId,
            params.absolutePath,
            clientId,
            budget
          )
    }
  }),
  defineMethod({
    name: 'files.writeTerminalArtifact',
    permission: 'workspace',
    params: TerminalArtifactFileWrite,
    handler: async (params, { runtime, clientId, clientKind }) =>
      runtime.writeTerminalArtifactFile(
        params.worktree,
        params.grantId,
        params.absolutePath,
        params.content,
        clientId,
        grantTextMaxBytes(clientKind)
      )
  })
]
