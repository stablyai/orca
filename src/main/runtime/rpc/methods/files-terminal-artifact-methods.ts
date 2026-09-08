import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { remoteFileContentBudget } from './files-remote-content-budget'
import { WorktreeSelector } from './files-target-schemas'
import { MOBILE_WEB_FILE_CHUNK_MAX_BYTES } from '../../../../shared/mobile-web/bridge-operation-contract'
import { MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES } from '../../../../shared/mobile-web/terminal-artifact-contract'

const TerminalArtifactFile = WorktreeSelector.extend({
  grantId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing terminal artifact grant')),
  absolutePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing terminal artifact path'))
})

const TerminalArtifactFileWrite = TerminalArtifactFile.extend({
  content: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
})

const TerminalArtifactFileChunk = TerminalArtifactFile.extend({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().min(1).max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES),
  maxBytes: z.number().int().min(1).max(MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES)
})

export const FILE_TERMINAL_ARTIFACT_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'files.readTerminalArtifact',
    params: TerminalArtifactFile,
    handler: async (params, { runtime, clientId }) =>
      runtime.readTerminalArtifactFile(
        params.worktree,
        params.grantId,
        params.absolutePath,
        clientId
      )
  }),
  defineMethod({
    name: 'files.readTerminalArtifactPreview',
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
    name: 'files.readTerminalArtifactChunk',
    params: TerminalArtifactFileChunk,
    handler: async (params, { runtime, clientId }) =>
      runtime.readTerminalArtifactChunk(
        params.worktree,
        params.grantId,
        params.absolutePath,
        params.offset,
        params.length,
        params.maxBytes,
        clientId
      )
  }),
  defineMethod({
    name: 'files.writeTerminalArtifact',
    params: TerminalArtifactFileWrite,
    handler: async (params, { runtime, clientId }) =>
      runtime.writeTerminalArtifactFile(
        params.worktree,
        params.grantId,
        params.absolutePath,
        params.content,
        clientId
      )
  })
]
