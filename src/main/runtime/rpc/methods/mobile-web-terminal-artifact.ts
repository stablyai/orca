import { z } from 'zod'
import { MOBILE_WEB_FILE_CHUNK_MAX_BYTES } from '../../../../shared/mobile-web/bridge-operation-contract'
import {
  MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES,
  MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES,
  MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS
} from '../../../../shared/mobile-web/terminal-artifact-contract'
import type { RuntimeTerminalPathOpenTarget } from '../../../../shared/runtime-file-contracts'
import { defineMethod, type RpcContext } from '../core'
import {
  mobileWebTerminalArtifactDisplayName,
  mobileWebTerminalArtifactPreviewKind
} from './mobile-web-terminal-artifact-presentation'
import { resolveMobileWebTerminalTab } from './mobile-web-terminal-tab-resolution'

const Target = z.object({
  worktree: z.string().min(1).max(4096),
  tabId: z.string().min(1).max(512),
  pathText: z.string().min(1).max(MOBILE_WEB_TERMINAL_PATH_MAX_CHARACTERS)
})
const Location = z.object({
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  column: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable()
})

export const MOBILE_WEB_TERMINAL_ARTIFACT_METHODS = [
  defineMethod({
    name: 'mobileWeb.terminal.resolvePath',
    params: Target.merge(Location),
    handler: async (params, context) => {
      const target = await resolveArtifactTarget(params, context)
      const path = target.kind === 'worktree-file' ? target.relativePath : target.absolutePath
      return {
        kind: target.kind === 'worktree-file' ? 'worktree-file' : 'terminal-artifact',
        ...(target.kind === 'worktree-file' ? { relativePath: target.relativePath } : {}),
        displayName: mobileWebTerminalArtifactDisplayName(path),
        previewKind: mobileWebTerminalArtifactPreviewKind(path),
        line: params.line,
        column: params.column
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.terminal.artifactChunk',
    params: Target.extend({
      offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      length: z.number().int().min(1).max(MOBILE_WEB_FILE_CHUNK_MAX_BYTES)
    }),
    handler: async (params, context) => {
      // Resolving per chunk is a local path lookup, and it re-earns the terminal's file grant
      // every time, so a retired terminal cannot keep serving bytes from an older grant.
      const target = await resolveArtifactTarget(params, context)
      if (target.kind !== 'absolute-file') {
        throw new Error('selector_not_found')
      }
      const maxBytes =
        mobileWebTerminalArtifactPreviewKind(target.absolutePath) === 'raster'
          ? MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES
          : MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES
      if (params.offset >= maxBytes || params.length > maxBytes - params.offset) {
        throw new Error('invalid_argument')
      }
      const chunk = await context.runtime.readTerminalArtifactChunk(
        params.worktree,
        target.grantId,
        target.absolutePath,
        params.offset,
        params.length,
        maxBytes,
        context.clientId
      )
      if (chunk.bytesRead > params.length || (!chunk.eof && chunk.bytesRead !== params.length)) {
        throw new Error('runtime_unavailable')
      }
      return {
        pathText: params.pathText,
        offset: params.offset,
        contentBase64: chunk.contentBase64,
        bytesRead: chunk.bytesRead,
        eof: chunk.eof
      }
    }
  })
]

/** The tab list owns which PTY the page's tab id names, and that PTY owns the file grant. */
async function resolveArtifactTarget(
  params: z.infer<typeof Target>,
  context: RpcContext
): Promise<Extract<RuntimeTerminalPathOpenTarget, { kind: 'worktree-file' | 'absolute-file' }>> {
  const terminal = await resolveMobileWebTerminalTab(context, params.worktree, params.tabId, {
    requireActive: true
  })
  const resolved = await context.runtime.resolveTerminalPath(
    params.worktree,
    params.pathText,
    null,
    context.clientId,
    terminal
  )
  // A resolution that lands outside the addressed worktree is a different workspace's file.
  if (
    `id:${resolved.worktree}` !== params.worktree ||
    !resolved.exists ||
    resolved.isDirectory ||
    (resolved.openTarget?.kind !== 'worktree-file' && resolved.openTarget?.kind !== 'absolute-file')
  ) {
    throw new Error('selector_not_found')
  }
  return resolved.openTarget
}
