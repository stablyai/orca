import { useEffect, useCallback } from 'react'
import * as Clipboard from 'expo-clipboard'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { triggerSelection, triggerSuccess, triggerError } from '../platform/haptics'
import {
  addMobileDiffComment,
  formatDiffComments,
  normalizeMobileDiffComments,
  removeDeliveredMobileDiffComments,
  removeMobileDiffComments
} from './mobile-diff-comments'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { MobileSessionDocumentReadersModel } from './use-mobile-session-document-readers'

export function useMobileSessionDiffComments(scope: MobileSessionDocumentReadersModel) {
  const {
    worktreeId,
    isFloatingWorkspaceRoute,
    client,
    connState,
    setDiffComments,
    diffCommentsRef,
    diffCommentBusy,
    setDiffCommentBusy,
    setPendingDiffNotesDelivery,
    showToast
  } = scope
  const loadDiffComments = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !worktreeId || isFloatingWorkspaceRoute) {
      setDiffComments([])
      return
    }
    const response = await client.sendRequest('worktree.show', {
      worktree: `id:${worktreeId}`
    })
    if (!response.ok) {
      return
    }
    const result = (response as RpcSuccess).result as {
      worktree?: { diffComments?: unknown }
    }
    setDiffComments(normalizeMobileDiffComments(result.worktree?.diffComments, worktreeId))
  }, [client, connState, worktreeId, isFloatingWorkspaceRoute])

  const persistDiffComments = useCallback(
    async (comments: readonly DiffComment[]): Promise<void> => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const response = await client.sendRequest('worktree.set', {
        worktree: `id:${worktreeId}`,
        diffComments: comments
      })
      if (!response.ok) {
        throw new Error((response as RpcFailure).error.message || 'Failed to save review notes')
      }
    },
    [client, connState, worktreeId]
  )

  useEffect(() => {
    void loadDiffComments()
  }, [loadDiffComments])

  const addDiffCommentForFile = useCallback(
    async (filePath: string, lineNumber: number, body: string): Promise<boolean> => {
      if (diffCommentBusy) {
        return false
      }
      const nextId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const result = addMobileDiffComment(diffCommentsRef.current, {
        id: nextId,
        worktreeId,
        filePath,
        lineNumber,
        body,
        createdAt: Date.now()
      })
      if (!result.comment) {
        return false
      }
      const previous = diffCommentsRef.current
      setDiffCommentBusy(true)
      setDiffComments(result.comments)
      try {
        await persistDiffComments(result.comments)
        triggerSuccess()
        showToast('Note added')
        return true
      } catch (err) {
        setDiffComments(previous)
        triggerError()
        showToast(err instanceof Error ? err.message : 'Failed to save note', 1600)
        return false
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [diffCommentBusy, persistDiffComments, showToast, worktreeId]
  )

  const deleteDiffCommentForFile = useCallback(
    async (commentId: string): Promise<void> => {
      if (diffCommentBusy) {
        return
      }
      const previous = diffCommentsRef.current
      const next = removeMobileDiffComments(previous, new Set([commentId]))
      if (next.length === previous.length) {
        return
      }
      setDiffCommentBusy(true)
      setDiffComments(next)
      try {
        await persistDiffComments(next)
        triggerSelection()
      } catch (err) {
        setDiffComments(previous)
        triggerError()
        showToast(err instanceof Error ? err.message : 'Failed to delete note', 1600)
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [diffCommentBusy, persistDiffComments, showToast]
  )

  const copyDiffCommentsToClipboard = useCallback(async (): Promise<void> => {
    const comments = diffCommentsRef.current
    if (comments.length === 0) {
      return
    }
    try {
      await Clipboard.setStringAsync(formatDiffComments(comments))
      triggerSuccess()
      showToast('Notes copied')
    } catch {
      triggerError()
      showToast("Couldn't copy notes", 1600)
    }
  }, [showToast])

  const sendDiffCommentsToAgent = useCallback((): void => {
    const comments = diffCommentsRef.current.filter((comment) => !comment.sentAt)
    if (comments.length === 0) {
      return
    }
    setPendingDiffNotesDelivery({
      comments: [...comments],
      prompt: formatDiffComments(comments)
    })
  }, [])

  const clearDeliveredDiffComments = useCallback(
    async (delivered: readonly DiffComment[]): Promise<void> => {
      const previous = diffCommentsRef.current
      const next = removeDeliveredMobileDiffComments(previous, delivered)
      if (next.length === previous.length) {
        return
      }
      setDiffCommentBusy(true)
      setDiffComments(next)
      try {
        await persistDiffComments(next)
      } catch {
        setDiffComments(previous)
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [persistDiffComments]
  )
  return {
    loadDiffComments,
    persistDiffComments,
    addDiffCommentForFile,
    deleteDiffCommentForFile,
    copyDiffCommentsToClipboard,
    sendDiffCommentsToAgent,
    clearDeliveredDiffComments
  }
}

export type MobileSessionDiffCommentsModel = MobileSessionDocumentReadersModel &
  ReturnType<typeof useMobileSessionDiffComments>
