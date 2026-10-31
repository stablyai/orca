import type { FileDocState, MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'

/** Retap of the open markdown or file tab is not a reload; refresh is a separate control. */
export function isCachedActiveDocumentRetap(
  tab: MobileSessionTab,
  activeSessionTabId: string | null,
  docs: {
    markdownDocs: ReadonlyMap<string, MarkdownDocState>
    fileDocs: ReadonlyMap<string, FileDocState>
  }
): boolean {
  if (tab.id !== activeSessionTabId || (tab.type !== 'markdown' && tab.type !== 'file')) {
    return false
  }
  const cached = tab.type === 'markdown' ? docs.markdownDocs.get(tab.id) : docs.fileDocs.get(tab.id)
  return cached !== undefined && cached.status !== 'error'
}
