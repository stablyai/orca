import { useCallback } from 'react'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTabApplicationModel } from './use-mobile-session-tab-application'

export function useMobileSessionDocumentReaders(scope: MobileSessionTabApplicationModel) {
  const {
    worktreeId,
    setMarkdownDocs,
    setFileDocs,
    fileDocLifecycleRef,
    markdownDocLifecycleRef,
    sessionFileOperations,
    sessionMarkdownOperations
  } = scope
  const readMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!sessionMarkdownOperations) {
        return
      }
      await markdownDocLifecycleRef.current.load(tab, setMarkdownDocs, () =>
        sessionMarkdownOperations.readTab({
          workspaceId: worktreeId,
          tabId: tab.id,
          relativePath: tab.relativePath,
          tabIsDirty: tab.isDirty
        })
      )
    },
    [sessionMarkdownOperations, worktreeId]
  )

  const readFileTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'file' }>) => {
      if (!sessionFileOperations) {
        return
      }
      await fileDocLifecycleRef.current.load(tab, setFileDocs, () =>
        sessionFileOperations.readTab({
          worktreeId,
          relativePath: tab.relativePath,
          diffSource: tab.diffSource
        })
      )
    },
    [sessionFileOperations, worktreeId]
  )
  return {
    readMarkdownTab,
    readFileTab
  }
}

export type MobileSessionDocumentReadersModel = MobileSessionTabApplicationModel &
  ReturnType<typeof useMobileSessionDocumentReaders>
