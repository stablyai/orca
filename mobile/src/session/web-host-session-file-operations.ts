import { Buffer } from 'buffer/'
import { buildImageDataUri } from '../../../src/shared/image-data-uri'
import {
  MOBILE_WEB_DIFF_MAX_ROWS,
  MOBILE_WEB_DIFF_PAGE_LIMIT
} from '../../../src/shared/mobile-web/source-control-operation-contract'
import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  type MobileWebFileChunkResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { MOBILE_WEB_RASTER_IMAGE_MAX_BYTES } from '../../../src/mobile-web/src/mobile-web-raster-image'
import type { MobileFileTabDoc, MobileFileTabDocRequest } from '../files/mobile-file-tab-doc'
import { classifyMobileArtifact } from './mobile-artifact-kind'
import type { HostSessionFileOperations } from './host-session-file-operations'

export function webHostSessionFileOperations(
  client: MobileWebBridgeClient
): HostSessionFileOperations {
  return {
    readTab(request) {
      return readWebHostSessionFileTab(client, request)
    }
  }
}

async function readWebHostSessionFileTab(
  client: MobileWebBridgeClient,
  request: MobileFileTabDocRequest
): Promise<MobileFileTabDoc> {
  if (request.diffSource === 'staged' || request.diffSource === 'unstaged') {
    return readWebHostSessionDiff(client, request)
  }
  if (classifyMobileArtifact(request.relativePath) === 'image') {
    return readWebHostSessionImage(client, request)
  }
  const result = await client.fileRead({
    workspaceId: request.worktreeId,
    relativePath: request.relativePath
  })
  return classifyMobileArtifact(request.relativePath) === 'html'
    ? { status: 'ready', kind: 'html', content: result.content }
    : {
        status: 'ready',
        kind: 'file',
        content: result.content,
        truncated: result.truncated,
        byteLength: result.byteLength
      }
}

async function readWebHostSessionDiff(
  client: MobileWebBridgeClient,
  request: MobileFileTabDocRequest
): Promise<MobileFileTabDoc> {
  const lines: Extract<MobileFileTabDoc, { kind: 'diff' }>['lines'] = []
  let offset = 0
  let expectedRevision: string | undefined
  let truncated = false
  while (offset < MOBILE_WEB_DIFF_MAX_ROWS) {
    const result = await client.sourceControlDiff({
      workspaceId: request.worktreeId,
      relativePath: request.relativePath,
      area: request.diffSource === 'staged' ? 'staged' : 'unstaged',
      offset,
      limit: MOBILE_WEB_DIFF_PAGE_LIMIT,
      ...(expectedRevision ? { expectedRevision } : {})
    })
    if (result.kind !== 'text') {
      throw new Error(result.kind === 'binary' ? 'binary_file' : 'file_too_large')
    }
    expectedRevision = result.revision
    lines.push(
      ...result.rows.map((row) => ({
        kind: row.kind,
        text: row.text,
        ...(row.oldLineNumber ? { oldLineNumber: row.oldLineNumber } : {}),
        ...(row.newLineNumber ? { newLineNumber: row.newLineNumber } : {})
      }))
    )
    truncated ||= result.truncated
    if (result.nextOffset === null) {
      break
    }
    offset = result.nextOffset
  }
  return { status: 'ready', kind: 'diff', lines, truncated }
}

async function readWebHostSessionImage(
  client: MobileWebBridgeClient,
  request: MobileFileTabDocRequest
): Promise<MobileFileTabDoc> {
  const chunks: MobileWebFileChunkResult[] = []
  let offset = 0
  let eof = false
  while (!eof && offset < MOBILE_WEB_RASTER_IMAGE_MAX_BYTES) {
    const chunk = await client.fileReadChunk({
      workspaceId: request.worktreeId,
      relativePath: request.relativePath,
      offset,
      length: Math.min(MOBILE_WEB_FILE_CHUNK_MAX_BYTES, MOBILE_WEB_RASTER_IMAGE_MAX_BYTES - offset)
    })
    chunks.push(chunk)
    offset += chunk.bytesRead
    eof = chunk.eof
  }
  if (!eof) {
    throw new Error('file_too_large')
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)))
  const dataUri = buildImageDataUri(rasterMimeType(request.relativePath), bytes.toString('base64'))
  if (!dataUri) {
    throw new Error('binary_file')
  }
  return { status: 'ready', kind: 'image', dataUri }
}

function rasterMimeType(relativePath: string): string | undefined {
  const extension = relativePath.split('.').at(-1)?.toLowerCase()
  if (extension === 'png') {
    return 'image/png'
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    return 'image/jpeg'
  }
  if (extension === 'gif') {
    return 'image/gif'
  }
  if (extension === 'webp') {
    return 'image/webp'
  }
  if (extension === 'bmp') {
    return 'image/bmp'
  }
  if (extension === 'ico') {
    return 'image/x-icon'
  }
  return undefined
}
