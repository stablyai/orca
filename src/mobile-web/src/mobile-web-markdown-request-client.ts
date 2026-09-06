import {
  MobileWebMarkdownDraftReadPayloadSchema,
  MobileWebMarkdownDraftReadResultSchema,
  MobileWebMarkdownDraftWritePayloadSchema,
  MobileWebMarkdownDraftWriteResultSchema,
  MobileWebMarkdownReadPayloadSchema,
  MobileWebMarkdownReadResultSchema,
  MobileWebMarkdownSavePayloadSchema,
  MobileWebMarkdownSaveResultSchema,
  type MobileWebMarkdownDraftReadPayload,
  type MobileWebMarkdownDraftWire,
  type MobileWebMarkdownReadPayload,
  type MobileWebMarkdownReadWireResult,
  type MobileWebMarkdownSaveWireResult
} from '../../shared/mobile-web/bridge-operation-contract'
import { MOBILE_MARKDOWN_EDIT_MAX_BYTES } from '../../shared/mobile-markdown-document'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import { decodeMobileWebFileBytes } from './mobile-web-file-content'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export type MobileWebMarkdownDraft = {
  content: string
  baseVersion: string
}

export type MobileWebMarkdownReadResult = Omit<MobileWebMarkdownReadWireResult, 'contentBase64'> & {
  content: string
}

export type MobileWebMarkdownSaveResult = Omit<MobileWebMarkdownSaveWireResult, 'contentBase64'> & {
  content: string
}

type MarkdownTarget = MobileWebMarkdownDraftReadPayload

export class MobileWebMarkdownRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  read(
    payload: MobileWebMarkdownReadPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebMarkdownReadResult> {
    return this.requests
      .request(
        'file',
        'markdownRead',
        payload,
        MobileWebMarkdownReadPayloadSchema,
        MobileWebMarkdownReadResultSchema,
        options
      )
      .then((result) => decodeReadResult(matchingTarget(payload, result)))
  }

  save(
    payload: MarkdownTarget & { content: string; baseVersion: string },
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebMarkdownSaveResult> {
    const wirePayload = {
      workspaceId: payload.workspaceId,
      tabId: payload.tabId,
      relativePath: payload.relativePath,
      baseVersion: payload.baseVersion,
      contentBase64: encodeMarkdownContent(payload.content)
    }
    return this.requests
      .request(
        'file',
        'markdownSave',
        wirePayload,
        MobileWebMarkdownSavePayloadSchema,
        MobileWebMarkdownSaveResultSchema,
        options
      )
      .then((result) => decodeSaveResult(matchingTarget(payload, result)))
  }

  loadDraft(
    payload: MarkdownTarget,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebMarkdownDraft | null> {
    return this.requests
      .request(
        'file',
        'markdownDraftRead',
        payload,
        MobileWebMarkdownDraftReadPayloadSchema,
        MobileWebMarkdownDraftReadResultSchema,
        options
      )
      .then((result) => matchingTarget(payload, result).draft)
      .then((draft) => (draft ? decodeDraft(draft) : null))
  }

  saveDraft(
    payload: MarkdownTarget & { draft: MobileWebMarkdownDraft | null },
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'file',
      'markdownDraftWrite',
      {
        ...payload,
        draft: payload.draft
          ? {
              contentBase64: encodeMarkdownContent(payload.draft.content),
              baseVersion: payload.draft.baseVersion
            }
          : null
      },
      MobileWebMarkdownDraftWritePayloadSchema,
      MobileWebMarkdownDraftWriteResultSchema,
      options
    )
  }
}

/** A tab is addressed by id; `relativePath` is only ever an echo, and the shell omits it for tabs
 * whose host path is not worktree-relative. */
function matchingTarget<T extends MarkdownTarget>(expected: MarkdownTarget, result: T): T {
  const relativePathDiverged =
    expected.relativePath !== undefined && result.relativePath !== expected.relativePath
  if (
    result.workspaceId !== expected.workspaceId ||
    result.tabId !== expected.tabId ||
    relativePathDiverged
  ) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return result
}

function encodeMarkdownContent(content: string): string {
  const bytes = new TextEncoder().encode(content)
  if (bytes.byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES) {
    throw new MobileWebBridgeClientError('too_large', false)
  }
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024))
  }
  return btoa(binary)
}

function decodeMarkdownContent(contentBase64: string): string {
  try {
    const bytes = decodeMobileWebFileBytes(contentBase64, MOBILE_MARKDOWN_EDIT_MAX_BYTES)
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    if (error instanceof MobileWebBridgeClientError) {
      throw error
    }
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
}

function decodeDraft(draft: MobileWebMarkdownDraftWire): MobileWebMarkdownDraft {
  return {
    content: decodeMarkdownContent(draft.contentBase64),
    baseVersion: draft.baseVersion
  }
}

function decodeReadResult(result: MobileWebMarkdownReadWireResult): MobileWebMarkdownReadResult {
  const { contentBase64, ...target } = result
  return { ...target, content: decodeMarkdownContent(contentBase64) }
}

function decodeSaveResult(result: MobileWebMarkdownSaveWireResult): MobileWebMarkdownSaveResult {
  const { contentBase64, ...target } = result
  return { ...target, content: decodeMarkdownContent(contentBase64) }
}
