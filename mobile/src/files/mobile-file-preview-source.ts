import type { MobileFilePreviewRouteParams } from './mobile-file-preview-route'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'

export function previewSourceFromRoute(
  params: MobileFilePreviewRouteParams
): MobileFilePreviewSource | null {
  if (params.source === 'terminalArtifact') {
    if (!params.absolutePath || !params.grantId) {
      return null
    }
    return {
      source: 'terminalArtifact',
      worktreeId: params.worktreeId,
      absolutePath: params.absolutePath,
      grantId: params.grantId,
      ...(params.terminal ? { terminalHandle: params.terminal } : {}),
      ...(params.pathText ? { pathText: params.pathText } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.nativeChatTab && params.nativeChatSession
        ? {
            nativeChatContext: {
              tabId: params.nativeChatTab,
              sessionId: params.nativeChatSession
            },
            readOnly: true as const
          }
        : {})
    }
  }
  if (!params.relativePath) {
    return null
  }
  return { source: 'worktree', worktreeId: params.worktreeId, relativePath: params.relativePath }
}

export function sourceKeyForPreview(source: MobileFilePreviewSource | null): string | null {
  if (!source) {
    return null
  }
  if (source.source !== 'terminalArtifact') {
    return JSON.stringify(['worktree', source.worktreeId, source.relativePath])
  }
  const key = ['terminal', source.worktreeId, source.absolutePath, source.terminalHandle ?? '']
  if (source.nativeChatContext) {
    key.push(source.nativeChatContext.tabId, source.nativeChatContext.sessionId)
  }
  return JSON.stringify(key)
}
