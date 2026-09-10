import { useCallback } from 'react'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTabApplicationModel } from './use-mobile-session-tab-application'

export function useMobileSessionDocumentReaders(scope: MobileSessionTabApplicationModel) {
  const { worktreeId, sessionOperations, setMarkdownDocs, setFileDocs } = scope
  const readMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!sessionOperations) {
        return
      }
      setMarkdownDocs((prev) => new Map(prev).set(tab.id, { status: 'loading' }))
      try {
        const doc = await sessionOperations.markdown.readTab({
          workspaceId: worktreeId,
          tabId: tab.id,
          relativePath: tab.relativePath,
          tabIsDirty: tab.isDirty
        })
        setMarkdownDocs((prev) => new Map(prev).set(tab.id, doc))
      } catch {
        setMarkdownDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'error',
            message: "Couldn't load markdown"
          })
        )
      }
    },
    [sessionOperations, worktreeId]
  )

  const readFileTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'file' }>) => {
      if (!sessionOperations) {
        return
      }
      setFileDocs((prev) => new Map(prev).set(tab.id, { status: 'loading' }))
      try {
        const doc = await sessionOperations.file.readTab({
          worktreeId,
          relativePath: tab.relativePath,
          diffSource: tab.diffSource
        })
        setFileDocs((prev) => new Map(prev).set(tab.id, doc))
      } catch (err) {
        const message = err instanceof Error ? err.message : ''
        const previewMessage =
          message === 'binary_file'
            ? 'Binary preview unavailable'
            : message === 'file_too_large'
              ? 'File too large for mobile preview'
              : tab.diffSource === 'staged' || tab.diffSource === 'unstaged'
                ? "Couldn't load diff preview"
                : "Couldn't load file preview"
        setFileDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'error',
            message: previewMessage
          })
        )
      }
    },
    [sessionOperations, worktreeId]
  )
  return {
    readMarkdownTab,
    readFileTab
  }
}

export type MobileSessionDocumentReadersModel = MobileSessionTabApplicationModel &
  ReturnType<typeof useMobileSessionDocumentReaders>
