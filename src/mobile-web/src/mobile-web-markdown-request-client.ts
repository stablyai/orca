import { z } from 'zod'
import {
  MobileWebMarkdownDraftReadPayloadSchema,
  MobileWebMarkdownDraftReadResultSchema,
  MobileWebMarkdownDraftWritePayloadSchema,
  MobileWebMarkdownDraftWriteResultSchema,
  MobileWebMarkdownReadPayloadSchema,
  MobileWebMarkdownReadResultSchema,
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
import { requestMobileWebHost } from './mobile-web-host-request-client'
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

const SaveOutcomeSchema = z.object({ outcome: z.enum(['saved', 'conflict']) })

export class MobileWebMarkdownRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  read(
    payload: MobileWebMarkdownReadPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebMarkdownReadResult> {
    if (!MobileWebMarkdownReadPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return requestMobileWebHost(
      this.requests,
      'mobileWeb.markdown.read',
      payload.workspaceId,
      {
        tabId: payload.tabId,
        ...(payload.relativePath ? { relativePath: payload.relativePath } : {}),
        tabIsDirty: payload.tabIsDirty
      },
      options
    ).then((result) =>
      decodeReadResult(parseHostResult(MobileWebMarkdownReadResultSchema, payload, result))
    )
  }

  save(
    payload: MarkdownTarget & { content: string; baseVersion: string },
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebMarkdownSaveResult> {
    return requestMobileWebHost(
      this.requests,
      'mobileWeb.markdown.save',
      payload.workspaceId,
      {
        tabId: payload.tabId,
        ...(payload.relativePath ? { relativePath: payload.relativePath } : {}),
        baseVersion: payload.baseVersion,
        contentBase64: encodeMarkdownContent(payload.content)
      },
      options
    ).then((result) => {
      const outcome = SaveOutcomeSchema.safeParse(result)
      if (!outcome.success) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      if (outcome.data.outcome === 'conflict') {
        throw new MobileWebBridgeClientError('conflict', false)
      }
      return decodeSaveResult(parseHostResult(MobileWebMarkdownSaveResultSchema, payload, result))
    })
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

/** The desktop answers a tab, not a workspace; the page restates the handle it addressed. */
function parseHostResult<T extends MarkdownTarget>(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  payload: MarkdownTarget,
  result: unknown
): T {
  const { outcome: _outcome, ...fields } =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)
      : ({} as Record<string, unknown>)
  const parsed = schema.safeParse({ ...fields, workspaceId: payload.workspaceId })
  if (!parsed.success) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return matchingTarget(payload, parsed.data as T)
}

/** A tab is addressed by id; `relativePath` is only ever an echo, and the desktop omits it for tabs
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
