import type { RpcFailure, RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  loadMobileSessionMarkdownDraft,
  saveMobileSessionMarkdownDraft
} from '../storage/mobile-session-markdown-drafts'
import {
  buildMarkdownDiskFallbackDoc,
  shouldReadMarkdownFromDiskAfterReadTabFailure
} from './mobile-markdown-disk-fallback'
import type {
  HostSessionMarkdownOperations,
  HostSessionMarkdownReadRequest,
  HostSessionMarkdownTarget
} from './host-session-markdown-operations'

const NATIVE_MOBILE_BUILD_IDENTITY = 'native-mobile-v1'

export function nativeHostSessionMarkdownOperations(
  client: RpcClient,
  hostId: string
): HostSessionMarkdownOperations {
  return {
    readTab: (request) => readNativeMarkdownTab(client, request),
    saveTab: async (request) => {
      const response = await client.sendRequest('markdown.saveTab', {
        worktree: `id:${request.workspaceId}`,
        tabId: request.tabId,
        baseVersion: request.baseVersion,
        content: request.content
      })
      if (!response.ok) {
        throw new Error((response as RpcFailure).error.message)
      }
      const result = (response as RpcSuccess).result as { content: string; version: string }
      return { content: result.content, baseVersion: result.version }
    },
    loadDraft: (target) => loadMobileSessionMarkdownDraft(draftScope(hostId, target)),
    saveDraft: (target, draft) => saveMobileSessionMarkdownDraft(draftScope(hostId, target), draft)
  }
}

async function readNativeMarkdownTab(
  client: RpcClient,
  request: HostSessionMarkdownReadRequest
): ReturnType<HostSessionMarkdownOperations['readTab']> {
  const response = await client.sendRequest('markdown.readTab', {
    worktree: `id:${request.workspaceId}`,
    tabId: request.tabId
  })
  if (response.ok) {
    const result = (response as RpcSuccess).result as {
      content: string
      version: string
      isDirty: boolean
      editable?: boolean
      readOnlyReason?: string
    }
    return {
      status: 'ready',
      content: result.content,
      localContent: result.content,
      baseVersion: result.version,
      isDirty: false,
      editable: result.editable === true,
      stale: result.isDirty,
      readOnlyReason: result.readOnlyReason
    }
  }
  if (!shouldReadMarkdownFromDiskAfterReadTabFailure(response as RpcFailure)) {
    throw new Error((response as RpcFailure).error.message)
  }
  const fallback = await client.sendRequest('files.read', {
    worktree: `id:${request.workspaceId}`,
    relativePath: request.relativePath
  })
  if (!fallback.ok) {
    throw new Error('Unable to read markdown')
  }
  const result = (fallback as RpcSuccess).result as {
    content: string
    truncated: boolean
  }
  return buildMarkdownDiskFallbackDoc({
    content: result.content,
    truncated: result.truncated,
    tabIsDirty: request.tabIsDirty
  })
}

function draftScope(hostId: string, target: HostSessionMarkdownTarget) {
  return {
    hostIdentity: hostId,
    buildIdentity: NATIVE_MOBILE_BUILD_IDENTITY,
    workspaceIdentity: target.workspaceId,
    tabIdentity: target.tabId,
    relativePath: target.relativePath
  }
}
