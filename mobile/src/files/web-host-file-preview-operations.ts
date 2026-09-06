import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionFileOperations } from '../session/web-host-session-file-operations'
import type { HostFilePreviewOperations } from './host-file-preview-operations'
import type { MobileFileTabDoc } from './mobile-file-tab-doc'
import { previewError, type MobileFilePreviewResult } from './mobile-file-preview-request'
import { isMarkdownPath } from './file-tree'

export function webHostFilePreviewOperations(
  client: MobileWebBridgeClient
): HostFilePreviewOperations {
  const fileOperations = webHostSessionFileOperations(client)
  return {
    async load(source) {
      if (source.source !== 'worktree') {
        return unsupportedTerminalArtifactPreview()
      }
      try {
        return previewResultFromFileTab(
          source.relativePath,
          await fileOperations.readTab({
            worktreeId: source.worktreeId,
            relativePath: source.relativePath
          })
        )
      } catch (error) {
        return previewError(error instanceof Error ? error.message : 'Unable to load preview')
      }
    },
    async saveTerminalArtifact() {
      return unsupportedTerminalArtifactPreview()
    },
    async reconnect() {
      await client.navigationReconnect()
    },
    async openExternalUrl(url) {
      await client.native.openExternal(url)
    }
  }
}

function unsupportedTerminalArtifactPreview(): MobileFilePreviewResult {
  return {
    status: 'error',
    message: 'Reload preview before saving',
    reconnect: false
  }
}

function previewResultFromFileTab(
  relativePath: string,
  document: MobileFileTabDoc
): MobileFilePreviewResult {
  if (document.kind === 'image') {
    return document
  }
  if (document.kind === 'diff') {
    return previewError('binary_file')
  }
  const kind =
    document.kind === 'html' ? 'html' : isMarkdownPath(relativePath) ? 'markdown' : 'text'
  if (document.content.length === 0) {
    return { status: 'empty', kind }
  }
  return {
    status: 'ready',
    kind,
    content: document.content,
    truncated: document.kind === 'file' ? document.truncated : false,
    byteLength: document.kind === 'file' ? document.byteLength : document.content.length
  }
}
