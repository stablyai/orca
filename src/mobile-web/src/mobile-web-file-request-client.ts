import { z } from 'zod'
import { projectMobileWebHostFileContent } from './mobile-web-host-file-content'
import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MobileWebFileListPayloadSchema,
  MobileWebFileListResultSchema,
  MobileWebFileOpenPayloadSchema,
  MobileWebFileReadPayloadSchema,
  MobileWebFileSearchPayloadSchema,
  type MobileWebFileListPayload,
  type MobileWebFileListResult,
  type MobileWebFileOpenPayload,
  type MobileWebFileReadPayload,
  type MobileWebFileReadResult,
  type MobileWebFileSearchPayload
} from '../../shared/mobile-web/bridge-operation-contract'
import {
  MOBILE_WEB_FILE_EDIT_MAX_BYTES,
  MobileWebFileWritePayloadSchema,
  type MobileWebFileWritePayload,
  type MobileWebFileWriteResult
} from '../../shared/mobile-web/file-edit-contract'
import {
  MobileWebTerminalArtifactChunkPayloadSchema,
  MobileWebTerminalArtifactChunkResultSchema,
  MobileWebTerminalPathResolvePayloadSchema,
  MobileWebTerminalPathResolveResultSchema,
  type MobileWebTerminalArtifactChunkPayload,
  type MobileWebTerminalArtifactChunkResult,
  type MobileWebTerminalPathResolvePayload,
  type MobileWebTerminalPathResolveResult
} from '../../shared/mobile-web/terminal-artifact-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { MobileWebFileReadClient } from './mobile-web-file-read-request-client'
import { decodeMobileWebFileBytes } from './mobile-web-file-content'
import { mobileWebFileRevision } from './mobile-web-file-edit-content'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'

const OpenResultSchema = z.object({ opened: z.literal(true) })
const WriteResultSchema = z.union([
  z.object({
    relativePath: z.string(),
    revision: z.string(),
    byteLength: z.number().int().nonnegative().max(MOBILE_WEB_FILE_EDIT_MAX_BYTES),
    outcome: z.literal('updated')
  }),
  z.object({ outcome: z.enum(['conflict', 'too_large']) })
])

// The desktop already types and redacts the list; the page only strips fields it does not know.
function projectListResult(
  result: unknown,
  workspaceId: string,
  limit: number
): MobileWebFileListResult {
  const parsed = MobileWebFileListResultSchema.omit({ workspaceId: true }).strip().safeParse(result)
  if (!parsed.success || parsed.data.files.length > limit) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return { ...parsed.data, workspaceId }
}

export class MobileWebFileRequestClient extends MobileWebFileReadClient {
  list(
    payload: MobileWebFileListPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileListResult> {
    if (!MobileWebFileListPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.searchPaths',
      payload.workspaceId,
      { query: '', limit: payload.limit },
      (result) => projectListResult(result, payload.workspaceId, payload.limit),
      options
    )
  }

  search(
    payload: MobileWebFileSearchPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileListResult> {
    if (!MobileWebFileSearchPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.searchPaths',
      payload.workspaceId,
      { query: payload.query, limit: payload.limit },
      (result) => projectListResult(result, payload.workspaceId, payload.limit),
      options
    )
  }

  read(
    payload: MobileWebFileReadPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileReadResult> {
    if (!MobileWebFileReadPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.read',
      payload.workspaceId,
      { relativePath: payload.relativePath },
      (result) => projectMobileWebHostFileContent(result, payload),
      options
    )
  }

  open(payload: MobileWebFileOpenPayload, options?: MobileWebBridgeRequestOptions): Promise<null> {
    if (!MobileWebFileOpenPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.open',
      payload.workspaceId,
      { relativePath: payload.relativePath, mode: 'edit' },
      (result) => {
        if (!OpenResultSchema.safeParse(result).success) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return null
      },
      options
    )
  }

  write(
    payload: MobileWebFileWritePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileWriteResult> {
    if (!MobileWebFileWritePayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.write',
      payload.workspaceId,
      {
        relativePath: payload.relativePath,
        expectedRevision: payload.expectedRevision,
        contentBase64: payload.contentBase64
      },
      (result) => projectWrite(payload, result),
      options
    )
  }

  resolveTerminalPath(
    payload: MobileWebTerminalPathResolvePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebTerminalPathResolveResult> {
    if (!MobileWebTerminalPathResolvePayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.terminal.resolvePath',
      payload.workspaceId,
      {
        tabId: payload.tabId,
        pathText: payload.pathText,
        line: payload.line,
        column: payload.column
      },
      // The page owns the location it asked about; only the target comes from the host.
      (result) => {
        const parsed = MobileWebTerminalPathResolveResultSchema.safeParse({
          ...(typeof result === 'object' && result !== null ? result : {}),
          workspaceId: payload.workspaceId,
          line: payload.line,
          column: payload.column
        })
        if (!parsed.success) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return parsed.data
      },
      options
    )
  }

  readTerminalArtifactChunk(
    payload: MobileWebTerminalArtifactChunkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebTerminalArtifactChunkResult> {
    if (!MobileWebTerminalArtifactChunkPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.terminal.artifactChunk',
      payload.workspaceId,
      {
        tabId: payload.tabId,
        pathText: payload.pathText,
        offset: payload.offset,
        length: payload.length
      },
      (result) => projectArtifactChunk(payload, result),
      options
    )
  }
}

function projectArtifactChunk(
  payload: MobileWebTerminalArtifactChunkPayload,
  result: unknown
): MobileWebTerminalArtifactChunkResult {
  const chunk =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
  const parsed = MobileWebTerminalArtifactChunkResultSchema.safeParse({
    workspaceId: payload.workspaceId,
    tabId: payload.tabId,
    pathText: chunk.pathText,
    offset: chunk.offset,
    contentBase64: chunk.contentBase64,
    bytesRead: chunk.bytesRead,
    eof: chunk.eof
  })
  if (
    !parsed.success ||
    parsed.data.pathText !== payload.pathText ||
    parsed.data.offset !== payload.offset ||
    parsed.data.bytesRead > payload.length
  ) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return {
    workspaceId: parsed.data.workspaceId,
    tabId: parsed.data.tabId,
    pathText: parsed.data.pathText,
    offset: parsed.data.offset,
    bytes: decodeMobileWebFileBytes(parsed.data.contentBase64, MOBILE_WEB_FILE_CHUNK_MAX_BYTES),
    bytesRead: parsed.data.bytesRead,
    eof: parsed.data.eof
  }
}

function projectWrite(
  payload: MobileWebFileWritePayload,
  result: unknown
): MobileWebFileWriteResult {
  const parsed = WriteResultSchema.safeParse(result)
  if (!parsed.success) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  if (parsed.data.outcome !== 'updated') {
    throw new MobileWebBridgeClientError(parsed.data.outcome, false)
  }
  const bytes = decodeMobileWebFileBytes(payload.contentBase64, MOBILE_WEB_FILE_EDIT_MAX_BYTES)
  if (
    parsed.data.relativePath !== payload.relativePath ||
    parsed.data.revision !== mobileWebFileRevision(bytes) ||
    parsed.data.byteLength !== bytes.byteLength
  ) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return { ...parsed.data, workspaceId: payload.workspaceId }
}
