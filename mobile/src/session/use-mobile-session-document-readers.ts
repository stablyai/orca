import { useCallback } from 'react'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { resolveMobileFileTabDoc } from '../files/mobile-file-tab-doc'
import {
  buildMarkdownDiskFallbackDoc,
  shouldReadMarkdownFromDiskAfterReadTabFailure
} from './mobile-markdown-disk-fallback'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTabApplicationModel } from './use-mobile-session-tab-application'

export function useMobileSessionDocumentReaders(scope: MobileSessionTabApplicationModel) {
  const { worktreeId, client, setMarkdownDocs, setFileDocs } = scope
  const readMarkdownTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'markdown' }>) => {
      if (!client) {
        return
      }
      setMarkdownDocs((prev) => new Map(prev).set(tab.id, { status: 'loading' }))
      try {
        const response = await client.sendRequest('markdown.readTab', {
          worktree: `id:${worktreeId}`,
          tabId: tab.id
        })
        if (response.ok) {
          const result = (response as RpcSuccess).result as {
            content: string
            version: string
            isDirty: boolean
            editable?: boolean
            readOnlyReason?: string
          }
          setMarkdownDocs((prev) =>
            new Map(prev).set(tab.id, {
              status: 'ready',
              content: result.content,
              localContent: result.content,
              baseVersion: result.version,
              isDirty: false,
              editable: result.editable === true,
              stale: result.isDirty,
              readOnlyReason: result.readOnlyReason
            })
          )
          return
        }
        if (!shouldReadMarkdownFromDiskAfterReadTabFailure(response as RpcFailure)) {
          throw new Error((response as RpcFailure).error.message)
        }
        // Why: a headless host fails markdown.readTab (renderer_unavailable); fall back to the on-disk file for read-only render.
        const fallback = await client.sendRequest('files.read', {
          worktree: `id:${worktreeId}`,
          relativePath: tab.relativePath
        })
        if (!fallback.ok) {
          throw new Error('Unable to read markdown')
        }
        const fileResult = (fallback as RpcSuccess).result as {
          content: string
          truncated: boolean
          byteLength: number
        }
        setMarkdownDocs((prev) =>
          new Map(prev).set(
            tab.id,
            buildMarkdownDiskFallbackDoc({
              content: fileResult.content,
              truncated: fileResult.truncated,
              tabIsDirty: tab.isDirty
            })
          )
        )
      } catch {
        setMarkdownDocs((prev) =>
          new Map(prev).set(tab.id, {
            status: 'error',
            message: "Couldn't load markdown"
          })
        )
      }
    },
    [client, worktreeId]
  )

  const readFileTab = useCallback(
    async (tab: Extract<MobileSessionTab, { type: 'file' }>) => {
      if (!client) {
        return
      }
      setFileDocs((prev) => new Map(prev).set(tab.id, { status: 'loading' }))
      try {
        const doc = await resolveMobileFileTabDoc(client, {
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
    [client, worktreeId]
  )
  return {
    readMarkdownTab,
    readFileTab
  }
}

export type MobileSessionDocumentReadersModel = MobileSessionTabApplicationModel &
  ReturnType<typeof useMobileSessionDocumentReaders>
