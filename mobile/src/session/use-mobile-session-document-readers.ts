import { useCallback, useRef } from 'react'
import type { RpcFailure } from '../transport/types'
import { resolveMobileFileTabDoc } from '../files/mobile-file-tab-doc'
import { filePreviewTextRead } from '../files/mobile-file-preview-operations'
import { markdownTabRead } from './mobile-session-read-operations'
import {
  buildMarkdownDiskFallbackDoc,
  shouldReadMarkdownFromDiskAfterReadTabFailure
} from './mobile-markdown-disk-fallback'
import {
  claimDocumentRead,
  commitDocumentRead,
  documentReadIsCurrent,
  installDocumentReadPlaceholder,
  keepFileVisibleDuringRead,
  keepMarkdownVisibleDuringRead,
  settleFileRead,
  settleMarkdownRead
} from './mobile-session-document-read-settlement'
import type { FileDocState, MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTabApplicationModel } from './use-mobile-session-tab-application'

export function useMobileSessionDocumentReaders(scope: MobileSessionTabApplicationModel) {
  const { worktreeId, client, markdownDocsRef, setMarkdownDocs, setFileDocs } = scope
  const markdownReadSeqRef = useRef(new Map<string, number>())
  const fileReadSeqRef = useRef(new Map<string, number>())
  const readMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!client) {
        return
      }
      const seq = claimDocumentRead(markdownReadSeqRef.current, tab.id)
      const visibleAtStart = markdownDocsRef.current.get(tab.id)
      // Why: swapping a visible document for `loading` unmounts the WebView and drops the caret.
      const loading: MarkdownDocState = { status: 'loading' }
      setMarkdownDocs((prev) =>
        installDocumentReadPlaceholder(prev, tab.id, loading, keepMarkdownVisibleDuringRead)
      )
      const publish = (nextDoc: MarkdownDocState) => {
        setMarkdownDocs((prev) => {
          if (!documentReadIsCurrent(markdownReadSeqRef.current, tab.id, seq)) {
            return prev
          }
          return commitDocumentRead(
            prev,
            tab.id,
            loading,
            nextDoc,
            (current, placeholder, result) =>
              settleMarkdownRead(current, placeholder, result, visibleAtStart)
          )
        })
      }
      try {
        const response = await markdownTabRead.request(client, {
          worktree: `id:${worktreeId}`,
          tabId: tab.id
        })
        if (response.ok) {
          const result = markdownTabRead.interpret(response)
          publish({
            status: 'ready',
            content: result.content,
            localContent: result.content,
            baseVersion: result.version,
            isDirty: false,
            editable: result.editable === true,
            stale: result.isDirty,
            readOnlyReason: result.readOnlyReason,
            ...(result.truncated === true ? { truncated: true, byteLength: result.byteLength } : {})
          })
          return
        }
        if (!shouldReadMarkdownFromDiskAfterReadTabFailure(response as RpcFailure)) {
          throw new Error((response as RpcFailure).error.message)
        }
        // Why: a headless host fails markdown.readTab (renderer_unavailable); fall back to the on-disk file for read-only render.
        const fallback = filePreviewTextRead.interpret(
          await filePreviewTextRead.request(client, {
            worktree: `id:${worktreeId}`,
            relativePath: tab.relativePath
          })
        )
        if (!fallback.accepted) {
          throw new Error('Unable to read markdown')
        }
        const fileResult = fallback.value
        publish(
          buildMarkdownDiskFallbackDoc({
            content: fileResult.content,
            truncated: fileResult.truncated,
            byteLength: fileResult.byteLength,
            tabIsDirty: tab.isDirty
          })
        )
      } catch (err) {
        publish({
          status: 'error',
          message: documentReadErrorMessage(err, "Couldn't load markdown")
        })
      }
    },
    [client, worktreeId]
  )

  const readFileTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'file' }>) => {
      if (!client) {
        return
      }
      const seq = claimDocumentRead(fileReadSeqRef.current, tab.id)
      const loading: FileDocState = { status: 'loading' }
      setFileDocs((prev) =>
        installDocumentReadPlaceholder(prev, tab.id, loading, keepFileVisibleDuringRead)
      )
      const publish = (nextDoc: FileDocState) => {
        setFileDocs((prev) => {
          if (!documentReadIsCurrent(fileReadSeqRef.current, tab.id, seq)) {
            return prev
          }
          return commitDocumentRead(prev, tab.id, loading, nextDoc, settleFileRead)
        })
      }
      try {
        const doc = await resolveMobileFileTabDoc(client, {
          worktreeId,
          relativePath: tab.relativePath,
          diffSource: tab.diffSource
        })
        publish(doc)
      } catch (err) {
        const previewMessage = documentReadErrorMessage(
          err,
          tab.diffSource === 'staged' || tab.diffSource === 'unstaged'
            ? "Couldn't load diff preview"
            : "Couldn't load file preview"
        )
        publish({ status: 'error', message: previewMessage })
      }
    },
    [client, worktreeId]
  )
  return {
    readMarkdownTab,
    readFileTab
  }
}

// Why: older desktops refuse oversize markdown as a bare runtime_error whose message is the code.
function documentReadErrorMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : ''
  if (message === 'binary_file') {
    return 'Binary preview unavailable'
  }
  if (message === 'file_too_large') {
    return 'File too large for mobile preview'
  }
  // Why: the host only serves workspace-relative paths; a desktop tab of an external file has none.
  if (message === 'invalid_relative_path') {
    return 'This file is outside the workspace. Open it on desktop to view it.'
  }
  return fallback
}

export type MobileSessionDocumentReadersModel = MobileSessionTabApplicationModel &
  ReturnType<typeof useMobileSessionDocumentReaders>
