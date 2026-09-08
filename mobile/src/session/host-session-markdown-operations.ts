import type { MarkdownDocState } from './mobile-session-route-types'

export type HostSessionMarkdownDraft = {
  content: string
  baseVersion: string
}

export type HostSessionMarkdownTarget = {
  workspaceId: string
  tabId: string
  relativePath: string
}

export type HostSessionMarkdownReadRequest = HostSessionMarkdownTarget & {
  tabIsDirty: boolean
}

export type HostSessionMarkdownSaveRequest = HostSessionMarkdownTarget & {
  content: string
  baseVersion: string
}

export type HostSessionMarkdownOperations = {
  readTab(
    request: HostSessionMarkdownReadRequest
  ): Promise<Extract<MarkdownDocState, { status: 'ready' }>>
  saveTab(request: HostSessionMarkdownSaveRequest): Promise<{
    content: string
    baseVersion: string
  }>
  loadDraft(target: HostSessionMarkdownTarget): Promise<HostSessionMarkdownDraft | null>
  saveDraft(
    target: HostSessionMarkdownTarget,
    draft: HostSessionMarkdownDraft | null
  ): Promise<void>
}
