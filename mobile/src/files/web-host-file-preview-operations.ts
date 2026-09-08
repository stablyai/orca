import { buildImageDataUri } from '../../../src/shared/image-data-uri'
import {
  MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES,
  MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES
} from '../../../src/shared/mobile-web/terminal-artifact-contract'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { validateMobileWebRasterImage } from '../../../src/mobile-web/src/mobile-web-raster-image'
import {
  readWebHostChunks,
  webHostSessionFileOperations
} from '../session/web-host-session-file-operations'
import type { HostFilePreviewOperations } from './host-file-preview-operations'
import type { MobileFileTabDoc } from './mobile-file-tab-doc'
import {
  previewError,
  type MobileFilePreviewResult,
  type MobileFilePreviewSource
} from './mobile-file-preview-request'
import { isMarkdownPath } from './file-tree'

export function webHostFilePreviewOperations(
  client: MobileWebBridgeClient
): HostFilePreviewOperations {
  const fileOperations = webHostSessionFileOperations(client)
  return {
    async load(source) {
      if (source.source === 'terminalArtifact') {
        return unsupportedTerminalArtifactPreview()
      }
      try {
        if (source.source === 'webArtifact') {
          return await readArtifact(client, source)
        }
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

async function readArtifact(
  client: MobileWebBridgeClient,
  source: Extract<MobileFilePreviewSource, { source: 'webArtifact' }>
): Promise<MobileFilePreviewResult> {
  const bytes = await readWebHostChunks(
    source.previewKind === 'text'
      ? MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES
      : MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES,
    (offset, length) =>
      client.fileReadTerminalArtifactChunk({
        workspaceId: source.worktreeId,
        tabId: source.tabId,
        pathText: source.pathText,
        offset,
        length
      })
  )
  if (source.previewKind === 'raster') {
    const image = validateMobileWebRasterImage({
      relativePath: source.displayName,
      bytes,
      eof: true,
      limitReached: false
    })
    const dataUri = image.valid
      ? buildImageDataUri(image.imageType.mimeType, bytes.toString('base64'))
      : null
    return dataUri ? { status: 'ready', kind: 'image', dataUri } : previewError('binary_file')
  }
  return previewResultFromFileTab(source.displayName, {
    status: 'ready',
    kind: 'file',
    content: bytes.toString('utf8'),
    truncated: false,
    byteLength: bytes.length
  })
}
