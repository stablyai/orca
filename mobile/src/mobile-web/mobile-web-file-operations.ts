import { Buffer } from 'buffer/'
import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MOBILE_WEB_FILE_CONTENT_MAX_BYTES,
  MobileWebFileChunkPayloadSchema,
  MobileWebFileChunkResultSchema,
  MobileWebFileDirectoryEntrySchema,
  MobileWebFileDirectoryPayloadSchema,
  MobileWebFileDirectoryResultSchema,
  MobileWebFileEntrySchema,
  MobileWebFileListPayloadSchema,
  MobileWebFileListResultSchema,
  MobileWebFileOpenPayloadSchema,
  MobileWebFileReadPayloadSchema,
  MobileWebFileReadResultSchema,
  MobileWebFileSearchPayloadSchema,
  type MobileWebFileChunkWireResult,
  type MobileWebFileDirectoryEntry,
  type MobileWebFileDirectoryResult,
  type MobileWebFileEntry,
  type MobileWebFileListResult,
  type MobileWebFileReadWireResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { MobileWebFileWriteResult } from '../../../src/shared/mobile-web/file-edit-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { executeMobileWebFileOpenOperation } from './mobile-web-file-open-operation'
import { executeMobileWebFileWrite } from './mobile-web-file-write'
import {
  compareMobileWebDirectoryEntries,
  mobileWebDirectoryRevision
} from './mobile-web-directory-presentation'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebFileOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<
  | MobileWebFileListResult
  | MobileWebFileDirectoryResult
  | MobileWebFileReadWireResult
  | MobileWebFileChunkWireResult
  | MobileWebFileWriteResult
  | null
> {
  if (args.operation === 'list') {
    const payload = MobileWebFileListPayloadSchema.parse(args.payload)
    return listFiles(
      args.client,
      payload.workspaceId,
      args.workspaceAuthority.hostWorkspaceId(payload.workspaceId),
      '',
      payload.limit
    )
  }
  if (args.operation === 'search') {
    const payload = MobileWebFileSearchPayloadSchema.parse(args.payload)
    return listFiles(
      args.client,
      payload.workspaceId,
      args.workspaceAuthority.hostWorkspaceId(payload.workspaceId),
      payload.query,
      payload.limit
    )
  }
  if (args.operation === 'read') {
    const payload = MobileWebFileReadPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('files.read', {
      worktree: `id:${hostWorkspaceId}`,
      relativePath: payload.relativePath
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeReadResult(
      response.result,
      payload.workspaceId,
      hostWorkspaceId,
      payload.relativePath
    )
  }
  if (args.operation === 'directory') {
    const payload = MobileWebFileDirectoryPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('files.readDir', {
      worktree: `id:${hostWorkspaceId}`,
      relativePath: payload.relativePath
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeDirectoryResult(
      response.result,
      payload.workspaceId,
      payload.relativePath,
      payload.limit
    )
  }
  if (args.operation === 'readChunk') {
    const payload = MobileWebFileChunkPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('files.readChunk', {
      worktree: `id:${hostWorkspaceId}`,
      relativePath: payload.relativePath,
      offset: payload.offset,
      length: payload.length
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return sanitizeChunkResult(response.result, payload)
  }
  if (args.operation === 'write') {
    return executeMobileWebFileWrite(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'open') {
    const payload = MobileWebFileOpenPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    return executeMobileWebFileOpenOperation({
      client: args.client,
      hostWorkspaceId,
      relativePath: payload.relativePath,
      assertCurrent: () =>
        args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function listFiles(
  client: RpcClient,
  pageWorkspaceId: string,
  hostWorkspaceId: string,
  query: string,
  limit: number
): Promise<MobileWebFileListResult> {
  const response = await client.sendRequest('files.searchPaths', {
    worktree: `id:${hostWorkspaceId}`,
    query,
    limit
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return sanitizeListResult(response.result, pageWorkspaceId, hostWorkspaceId, limit)
}

function sanitizeListResult(
  result: unknown,
  pageWorkspaceId: string,
  hostWorkspaceId: string,
  limit: number
): MobileWebFileListResult {
  if (!isRecord(result) || result.worktree !== hostWorkspaceId || !Array.isArray(result.files)) {
    throw new MobileWebBrokerError('host_error')
  }
  const files = result.files.slice(0, limit).flatMap((value): MobileWebFileEntry[] => {
    if (!isRecord(value) || typeof value.relativePath !== 'string') {
      return []
    }
    const parsed = MobileWebFileEntrySchema.safeParse({
      relativePath: value.relativePath,
      basename: value.relativePath.split('/').at(-1)?.slice(0, 255),
      kind: value.kind === 'binary' ? 'binary' : 'text'
    })
    return parsed.success ? [parsed.data] : []
  })
  const totalCount =
    typeof result.totalCount === 'number' &&
    Number.isSafeInteger(result.totalCount) &&
    result.totalCount >= 0
      ? result.totalCount
      : result.files.length
  return MobileWebFileListResultSchema.parse({
    workspaceId: pageWorkspaceId,
    files,
    totalCount,
    truncated:
      result.truncated === true || result.files.length > files.length || totalCount > files.length
  })
}

function sanitizeReadResult(
  result: unknown,
  pageWorkspaceId: string,
  hostWorkspaceId: string,
  relativePath: string
): MobileWebFileReadWireResult {
  if (
    !isRecord(result) ||
    result.worktree !== hostWorkspaceId ||
    result.relativePath !== relativePath ||
    typeof result.content !== 'string' ||
    typeof result.byteLength !== 'number' ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength < 0
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  const encoded = Buffer.from(result.content, 'utf8')
  if (result.byteLength < encoded.byteLength) {
    throw new MobileWebBrokerError('host_error')
  }
  const content = truncateUtf8(result.content, encoded)
  return MobileWebFileReadResultSchema.parse({
    workspaceId: pageWorkspaceId,
    relativePath,
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    truncated: result.truncated === true || content !== result.content,
    byteLength: result.byteLength
  })
}

function sanitizeDirectoryResult(
  result: unknown,
  workspaceId: string,
  relativePath: string,
  limit: number
): MobileWebFileDirectoryResult {
  if (!Array.isArray(result)) {
    throw new MobileWebBrokerError('host_error')
  }
  const names = new Set<string>()
  const entries = result.slice(0, limit).flatMap((value): MobileWebFileDirectoryEntry[] => {
    if (!isRecord(value) || typeof value.name !== 'string' || names.has(value.name)) {
      return []
    }
    const parsed = MobileWebFileDirectoryEntrySchema.safeParse({
      name: value.name,
      isDirectory: value.isDirectory === true,
      isSymlink: value.isSymlink === true
    })
    if (!parsed.success) {
      return []
    }
    names.add(parsed.data.name)
    return [parsed.data]
  })
  entries.sort(compareMobileWebDirectoryEntries)
  const truncated = result.length > entries.length
  return MobileWebFileDirectoryResultSchema.parse({
    workspaceId,
    relativePath,
    revision: mobileWebDirectoryRevision(entries, truncated),
    entries,
    truncated
  })
}

function sanitizeChunkResult(
  result: unknown,
  payload: {
    workspaceId: string
    relativePath: string
    offset: number
    length: number
  }
): MobileWebFileChunkWireResult {
  if (
    !isRecord(result) ||
    typeof result.contentBase64 !== 'string' ||
    typeof result.bytesRead !== 'number' ||
    !Number.isSafeInteger(result.bytesRead) ||
    result.bytesRead < 0 ||
    result.bytesRead > payload.length ||
    result.bytesRead > MOBILE_WEB_FILE_CHUNK_MAX_BYTES ||
    typeof result.eof !== 'boolean'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebFileChunkResultSchema.parse({
    workspaceId: payload.workspaceId,
    relativePath: payload.relativePath,
    offset: payload.offset,
    contentBase64: result.contentBase64,
    bytesRead: result.bytesRead,
    eof: result.eof
  })
}

function truncateUtf8(content: string, encoded: Buffer): string {
  if (encoded.byteLength <= MOBILE_WEB_FILE_CONTENT_MAX_BYTES) {
    return content
  }
  let truncated = Buffer.from(encoded.subarray(0, MOBILE_WEB_FILE_CONTENT_MAX_BYTES)).toString(
    'utf8'
  )
  while (Buffer.byteLength(truncated, 'utf8') > MOBILE_WEB_FILE_CONTENT_MAX_BYTES) {
    truncated = truncated.slice(0, -1)
  }
  return truncated
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
