import { Buffer } from 'buffer/'
import {
  MobileWebRelativePathSchema,
  MobileWebMarkdownDraftReadPayloadSchema,
  MobileWebMarkdownDraftReadResultSchema,
  MobileWebMarkdownDraftWritePayloadSchema,
  MobileWebMarkdownReadPayloadSchema,
  MobileWebMarkdownReadResultSchema,
  MobileWebMarkdownSavePayloadSchema,
  MobileWebMarkdownSaveResultSchema
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import {
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES
} from '../../../src/shared/mobile-markdown-document'
import {
  buildMarkdownDiskFallbackDoc,
  MARKDOWN_TOO_LARGE_READ_ONLY_REASON,
  shouldReadMarkdownFromDiskAfterReadTabFailure
} from '../session/mobile-markdown-disk-fallback'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure } from '../transport/types'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type {
  MobileWebHostWorkspaceId,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

type MarkdownOperationArgs = {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
  nativeAuthority: Pick<
    MobileWebNativeCapabilityAuthority,
    'sessionMarkdownDraftRead' | 'sessionMarkdownDraftWrite'
  >
}

type MarkdownTarget = {
  workspaceId: string
  tabId: string
  relativePath?: string
}

/** The tab as the host records it; `hostRelativePath` may be absolute for a file opened outside
 * the worktree, so it never leaves the shell except through `safeRelativePath`. */
type ResolvedMarkdownTab = {
  hostWorkspaceId: MobileWebHostWorkspaceId
  hostRelativePath: string
}

export async function executeMobileWebMarkdownOperation(
  args: MarkdownOperationArgs
): Promise<unknown> {
  if (args.operation === 'markdownRead') {
    const payload = MobileWebMarkdownReadPayloadSchema.parse(args.payload)
    const tab = await resolveMarkdownTab(args, payload)
    return readMarkdown(args.client, payload, tab)
  }
  if (args.operation === 'markdownSave') {
    const payload = MobileWebMarkdownSavePayloadSchema.parse(args.payload)
    const tab = await resolveMarkdownTab(args, payload)
    args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, tab.hostWorkspaceId)
    return saveMarkdown(args.client, payload, tab)
  }
  if (args.operation === 'markdownDraftRead') {
    const payload = MobileWebMarkdownDraftReadPayloadSchema.parse(args.payload)
    const tab = await resolveMarkdownTab(args, payload)
    if (!args.nativeAuthority.sessionMarkdownDraftRead) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    const draft = await args.nativeAuthority.sessionMarkdownDraftRead(
      tab.hostWorkspaceId,
      payload.tabId,
      tab.hostRelativePath
    )
    return parseHostResult(
      MobileWebMarkdownDraftReadResultSchema,
      targetResult(payload, tab, {
        draft: draft
          ? {
              contentBase64: encodeMarkdownContent(draft.content),
              baseVersion: draft.baseVersion
            }
          : null
      })
    )
  }
  if (args.operation === 'markdownDraftWrite') {
    const payload = MobileWebMarkdownDraftWritePayloadSchema.parse(args.payload)
    const tab = await resolveMarkdownTab(args, payload)
    if (!args.nativeAuthority.sessionMarkdownDraftWrite) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, tab.hostWorkspaceId)
    await args.nativeAuthority.sessionMarkdownDraftWrite(
      tab.hostWorkspaceId,
      payload.tabId,
      tab.hostRelativePath,
      payload.draft
        ? {
            content: decodeMarkdownContent(payload.draft.contentBase64),
            baseVersion: payload.draft.baseVersion
          }
        : null
    )
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

/** The host tab list is the only authority on which file a tab id names. */
async function resolveMarkdownTab(
  args: MarkdownOperationArgs,
  target: MarkdownTarget
): Promise<ResolvedMarkdownTab> {
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(target.workspaceId)
  const response = await args.client.sendRequest('session.tabs.list', {
    worktree: `id:${hostWorkspaceId}`
  })
  const result = response.ok && isRecord(response.result) ? response.result : null
  const tab =
    result?.worktree === hostWorkspaceId && Array.isArray(result.tabs)
      ? result.tabs.find(
          (value) => isRecord(value) && value.id === target.tabId && value.type === 'markdown'
        )
      : null
  if (!isRecord(tab) || typeof tab.relativePath !== 'string' || !tab.relativePath) {
    throw new MobileWebBrokerError('not_found')
  }
  // A page that could name the path still asserts it, so a rename under the tab is refused rather
  // than silently redirected. Tabs whose host path the page cannot express send nothing.
  if (target.relativePath !== undefined && target.relativePath !== tab.relativePath) {
    throw new MobileWebBrokerError('not_found')
  }
  return { hostWorkspaceId, hostRelativePath: tab.relativePath }
}

async function readMarkdown(
  client: RpcClient,
  payload: MarkdownTarget & { tabIsDirty: boolean },
  tab: ResolvedMarkdownTab
) {
  const response = await client.sendRequest('markdown.readTab', {
    worktree: `id:${tab.hostWorkspaceId}`,
    tabId: payload.tabId
  })
  if (!response.ok) {
    if (!shouldReadMarkdownFromDiskAfterReadTabFailure(response as RpcFailure)) {
      throw new MobileWebBrokerError('host_error')
    }
    return readMarkdownFallback(client, payload, tab)
  }
  const result = response.result
  if (
    !isRecord(result) ||
    result.tabId !== payload.tabId ||
    result.relativePath !== tab.hostRelativePath ||
    typeof result.content !== 'string' ||
    typeof result.version !== 'string' ||
    typeof result.isDirty !== 'boolean' ||
    typeof result.editable !== 'boolean'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  const readable = clampMarkdownReadContent(result.content)
  const readOnlyReason = readable.truncated
    ? MARKDOWN_TOO_LARGE_READ_ONLY_REASON
    : typeof result.readOnlyReason === 'string'
      ? result.readOnlyReason
      : undefined
  return parseHostResult(
    MobileWebMarkdownReadResultSchema,
    targetResult(payload, tab, {
      contentBase64: encodeMarkdownContent(readable.content),
      baseVersion: result.version,
      editable: result.editable && !readable.truncated,
      stale: result.isDirty,
      ...(readOnlyReason ? { readOnlyReason } : {})
    })
  )
}

async function readMarkdownFallback(
  client: RpcClient,
  payload: MarkdownTarget & { tabIsDirty: boolean },
  tab: ResolvedMarkdownTab
) {
  const response = await client.sendRequest('files.read', {
    worktree: `id:${tab.hostWorkspaceId}`,
    relativePath: tab.hostRelativePath
  })
  const result = response.ok ? response.result : null
  if (
    !isRecord(result) ||
    result.worktree !== tab.hostWorkspaceId ||
    result.relativePath !== tab.hostRelativePath ||
    typeof result.content !== 'string' ||
    typeof result.truncated !== 'boolean'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  const readable = clampMarkdownReadContent(result.content)
  const fallback = buildMarkdownDiskFallbackDoc({
    content: readable.content,
    truncated: result.truncated || readable.truncated,
    tabIsDirty: payload.tabIsDirty
  })
  return parseHostResult(
    MobileWebMarkdownReadResultSchema,
    targetResult(payload, tab, {
      contentBase64: encodeMarkdownContent(fallback.content),
      baseVersion: fallback.baseVersion,
      editable: fallback.editable,
      stale: fallback.stale === true,
      readOnlyReason: fallback.readOnlyReason
    })
  )
}

async function saveMarkdown(
  client: RpcClient,
  payload: MarkdownTarget & { baseVersion: string; contentBase64: string },
  tab: ResolvedMarkdownTab
) {
  const response = await client.sendRequest('markdown.saveTab', {
    worktree: `id:${tab.hostWorkspaceId}`,
    tabId: payload.tabId,
    baseVersion: payload.baseVersion,
    content: decodeMarkdownContent(payload.contentBase64)
  })
  if (!response.ok) {
    const failure = response as RpcFailure
    if (failure.error.code === 'conflict' || failure.error.message === 'conflict') {
      throw new MobileWebBrokerError('conflict')
    }
    throw new MobileWebBrokerError('host_error')
  }
  const result = response.result
  if (
    !isRecord(result) ||
    result.tabId !== payload.tabId ||
    result.isDirty !== false ||
    typeof result.content !== 'string' ||
    typeof result.version !== 'string'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return parseHostResult(
    MobileWebMarkdownSaveResultSchema,
    targetResult(payload, tab, {
      contentBase64: encodeMarkdownContent(result.content),
      baseVersion: result.version
    })
  )
}

/** Reads must survive documents past the edit ceiling: the host already serves those read-only. */
function clampMarkdownReadContent(content: string): { content: string; truncated: boolean } {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength <= MOBILE_MARKDOWN_EDIT_MAX_BYTES) {
    return { content, truncated: false }
  }
  let end = MOBILE_MARKDOWN_EDIT_MAX_BYTES
  // Never split a UTF-8 sequence; continuation bytes are 0b10xxxxxx.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1
  }
  return { content: bytes.slice(0, end).toString('utf8'), truncated: true }
}

function encodeMarkdownContent(content: string): string {
  if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
    throw new MobileWebBrokerError('host_error')
  }
  return Buffer.from(content, 'utf8').toString('base64')
}

function decodeMarkdownContent(contentBase64: string): string {
  const bytes = Buffer.from(contentBase64, 'base64')
  const content = bytes.toString('utf8')
  if (
    bytes.byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES ||
    !Buffer.from(content, 'utf8').equals(bytes)
  ) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return content
}

function targetResult(
  target: MarkdownTarget,
  tab: ResolvedMarkdownTab,
  result: Record<string, unknown>
) {
  const relativePath = MobileWebRelativePathSchema.safeParse(tab.hostRelativePath)
  return {
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    ...(relativePath.success ? { relativePath: relativePath.data } : {}),
    ...result
  }
}

function parseHostResult<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
