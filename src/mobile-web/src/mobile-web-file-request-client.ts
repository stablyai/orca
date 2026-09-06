import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MobileWebFileChunkPayloadSchema,
  MobileWebFileChunkResultSchema,
  MobileWebFileDirectoryPayloadSchema,
  MobileWebFileDirectoryResultSchema,
  MobileWebFileListPayloadSchema,
  MobileWebFileListResultSchema,
  MobileWebFileOpenPayloadSchema,
  MobileWebFileOpenResultSchema,
  MobileWebFileReadPayloadSchema,
  MobileWebFileReadResultSchema,
  MobileWebFileSearchPayloadSchema,
  type MobileWebFileChunkPayload,
  type MobileWebFileChunkResult,
  type MobileWebFileDirectoryPayload,
  type MobileWebFileDirectoryResult,
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
  MobileWebFileWriteResultSchema,
  type MobileWebFileWritePayload,
  type MobileWebFileWriteResult
} from '../../shared/mobile-web/file-edit-contract'
import {
  MobileWebTerminalArtifactChunkPayloadSchema,
  MobileWebTerminalArtifactChunkResultSchema,
  MobileWebTerminalArtifactReleasePayloadSchema,
  MobileWebTerminalArtifactReleaseResultSchema,
  MobileWebTerminalPathResolvePayloadSchema,
  MobileWebTerminalPathResolveResultSchema,
  type MobileWebTerminalArtifactChunkPayload,
  type MobileWebTerminalArtifactChunkResult,
  type MobileWebTerminalArtifactReleasePayload,
  type MobileWebTerminalPathResolvePayload,
  type MobileWebTerminalPathResolveResult
} from '../../shared/mobile-web/terminal-artifact-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import { decodeMobileWebFileChunk } from './mobile-web-file-chunk'
import { decodeMobileWebFileBytes, decodeMobileWebFileContent } from './mobile-web-file-content'
import { mobileWebFileRevision } from './mobile-web-file-edit-content'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebFileRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  list(
    payload: MobileWebFileListPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileListResult> {
    return this.requests
      .request(
        'file',
        'list',
        payload,
        MobileWebFileListPayloadSchema,
        MobileWebFileListResultSchema,
        options
      )
      .then((result) => matchingFileList(payload, result))
  }

  search(
    payload: MobileWebFileSearchPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileListResult> {
    return this.requests
      .request(
        'file',
        'search',
        payload,
        MobileWebFileSearchPayloadSchema,
        MobileWebFileListResultSchema,
        options
      )
      .then((result) => matchingFileList(payload, result))
  }

  directory(
    payload: MobileWebFileDirectoryPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileDirectoryResult> {
    return this.requests
      .request(
        'file',
        'directory',
        payload,
        MobileWebFileDirectoryPayloadSchema,
        MobileWebFileDirectoryResultSchema,
        options
      )
      .then((result) => {
        if (result.entries.length > payload.limit) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return matchingFile(payload, result)
      })
  }

  read(
    payload: MobileWebFileReadPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileReadResult> {
    return this.requests
      .request(
        'file',
        'read',
        payload,
        MobileWebFileReadPayloadSchema,
        MobileWebFileReadResultSchema,
        options
      )
      .then(decodeMobileWebFileContent)
      .then((result) => matchingFile(payload, result))
  }

  open(payload: MobileWebFileOpenPayload, options?: MobileWebBridgeRequestOptions): Promise<null> {
    return this.requests.request(
      'file',
      'open',
      payload,
      MobileWebFileOpenPayloadSchema,
      MobileWebFileOpenResultSchema,
      options
    )
  }

  readChunk(
    payload: MobileWebFileChunkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileChunkResult> {
    return this.requests
      .request(
        'file',
        'readChunk',
        payload,
        MobileWebFileChunkPayloadSchema,
        MobileWebFileChunkResultSchema,
        options
      )
      .then(decodeMobileWebFileChunk)
      .then((result) => {
        if (result.offset !== payload.offset || result.bytesRead > payload.length) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return matchingFile(payload, result)
      })
  }

  write(
    payload: MobileWebFileWritePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileWriteResult> {
    return this.requests
      .request(
        'file',
        'write',
        payload,
        MobileWebFileWritePayloadSchema,
        MobileWebFileWriteResultSchema,
        options
      )
      .then((result) => matchingWrite(payload, result))
  }

  resolveTerminalPath(
    payload: MobileWebTerminalPathResolvePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebTerminalPathResolveResult> {
    return this.requests
      .request(
        'file',
        'resolveTerminalPath',
        payload,
        MobileWebTerminalPathResolvePayloadSchema,
        MobileWebTerminalPathResolveResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  readTerminalArtifactChunk(
    payload: MobileWebTerminalArtifactChunkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebTerminalArtifactChunkResult> {
    return this.requests
      .request(
        'file',
        'readTerminalArtifactChunk',
        payload,
        MobileWebTerminalArtifactChunkPayloadSchema,
        MobileWebTerminalArtifactChunkResultSchema,
        options
      )
      .then((result): MobileWebTerminalArtifactChunkResult => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.tabId !== payload.tabId ||
          result.token !== payload.token ||
          result.offset !== payload.offset
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        const bytes = decodeMobileWebFileBytes(
          result.contentBase64,
          MOBILE_WEB_FILE_CHUNK_MAX_BYTES
        )
        if (bytes.byteLength !== result.bytesRead || result.bytesRead > payload.length) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return {
          workspaceId: result.workspaceId,
          tabId: result.tabId,
          token: result.token,
          offset: result.offset,
          bytes,
          bytesRead: result.bytesRead,
          eof: result.eof
        }
      })
  }

  releaseTerminalArtifact(
    payload: MobileWebTerminalArtifactReleasePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'file',
      'releaseTerminalArtifact',
      payload,
      MobileWebTerminalArtifactReleasePayloadSchema,
      MobileWebTerminalArtifactReleaseResultSchema,
      options
    )
  }
}

function matchingWrite(
  payload: MobileWebFileWritePayload,
  result: MobileWebFileWriteResult
): MobileWebFileWriteResult {
  const bytes = decodeMobileWebFileBytes(payload.contentBase64, MOBILE_WEB_FILE_EDIT_MAX_BYTES)
  if (result.revision !== mobileWebFileRevision(bytes) || result.byteLength !== bytes.byteLength) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return matchingFile(payload, result)
}

function matchingFileList(
  payload: MobileWebFileListPayload | MobileWebFileSearchPayload,
  result: MobileWebFileListResult
): MobileWebFileListResult {
  if (result.files.length > payload.limit) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return requireEchoedWorkspaceId(payload.workspaceId, result)
}

function matchingFile<
  TPayload extends { workspaceId: string; relativePath: string },
  TResult extends { workspaceId: string; relativePath: string }
>(payload: TPayload, result: TResult): TResult {
  if (result.relativePath !== payload.relativePath) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return requireEchoedWorkspaceId(payload.workspaceId, result)
}
