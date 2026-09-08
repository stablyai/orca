import type { MobileFilePreviewRouteParams } from './mobile-file-preview-route'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'

export function previewSourceFromRoute(
  params: MobileFilePreviewRouteParams
): MobileFilePreviewSource | null {
  if (params.source === 'webArtifact') {
    if (!params.terminal || !params.pathText || !params.previewKind || !params.name) {
      return null
    }
    return {
      source: 'webArtifact',
      worktreeId: params.worktreeId,
      tabId: params.terminal,
      pathText: params.pathText,
      displayName: params.name,
      previewKind: params.previewKind
    }
  }
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
  if (source.source === 'webArtifact') {
    return JSON.stringify(source)
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

export function sourceRevisionForPreview(source: MobileFilePreviewSource | null): string | null {
  if (!source) {
    return null
  }
  if (source.source === 'webArtifact') {
    return sourceKeyForPreview(source)
  }
  return source.source === 'terminalArtifact'
    ? JSON.stringify([
        'terminal',
        source.worktreeId,
        source.absolutePath,
        source.grantId,
        source.terminalHandle ?? '',
        source.pathText ?? '',
        source.cwd ?? ''
      ])
    : JSON.stringify(['worktree', source.worktreeId, source.relativePath])
}
