import { useEffect, useCallback, useRef, useState } from 'react'
import { useClipboardWriter } from '../platform/clipboard'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { sessionWorktreeRecordRead } from './mobile-session-read-operations'
import { sessionWorktreeNotesWrite } from './mobile-session-write-operations'
import { triggerSelection, triggerSuccess, triggerError } from '../platform/haptics'
import {
  addMobileDiffComment,
  formatDiffComments,
  normalizeMobileDiffComments,
  removeDeliveredMobileDiffComments,
  removeMobileDiffComments,
  sendableMobileDiffComments
} from './mobile-diff-comments'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { DiffNotesDelivery } from './mobile-session-route-types'
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
  const clipboard = useClipboardWriter()
  // Why: a new agent's reply can outlast the "+" lock by a minute, and resending notes it still
  // carries would start a second agent with them. Held from the tap until that reply settles.
  const sendingDiffCommentIdsRef = useRef<ReadonlySet<string>>(new Set())
  const [sendingDiffCommentIds, setSendingDiffCommentIds] = useState<ReadonlySet<string>>(
    sendingDiffCommentIdsRef.current
  )
  const loadDiffComments = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !worktreeId || isFloatingWorkspaceRoute) {
      setDiffComments([])
      return
    }
    const response = sessionWorktreeRecordRead.interpret(
      await sessionWorktreeRecordRead.request(client, { worktree: `id:${worktreeId}` })
    )
    if (!response.accepted) {
      return
    }
    setDiffComments(normalizeMobileDiffComments(response.value?.diffComments, worktreeId))
  }, [client, connState, worktreeId, isFloatingWorkspaceRoute])

  const persistDiffComments = useCallback(
    async (comments: readonly DiffComment[]): Promise<void> => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const response = await sessionWorktreeNotesWrite.request(client, {
        worktree: `id:${worktreeId}`,
        diffComments: [...comments]
      })
      interpretOrThrowRefusalMessage(
        () => sessionWorktreeNotesWrite.interpret(response),
        'Failed to save review notes'
      )
    },
    [client, connState, worktreeId]
  )

  useEffect(() => {
    // Caught here and not in the loader: a *rejected* `worktree.show` would otherwise be an
    // unhandled rejection on every mount, and the loader's own promise is awaited by the recording
    // adapter, which a swallowed rejection inside it would hide.
    void loadDiffComments().catch(() => undefined)
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
      await clipboard.writeText(formatDiffComments(comments))
      triggerSuccess()
      showToast('Notes copied')
    } catch {
      triggerError()
      showToast("Couldn't copy notes", 1600)
    }
  }, [clipboard, showToast])

  const sendDiffCommentsToAgent = useCallback((): void => {
    const comments = sendableMobileDiffComments(
      diffCommentsRef.current,
      sendingDiffCommentIdsRef.current
    )
    if (comments.length === 0) {
      return
    }
    setPendingDiffNotesDelivery({
      comments: [...comments],
      prompt: formatDiffComments(comments)
    })
  }, [])

  const sendDiffNotesToNewAgent = useCallback(
    async (delivery: DiffNotesDelivery, launch: () => Promise<void>): Promise<void> => {
      const ids = delivery.comments.map((comment) => comment.id)
      if (ids.some((id) => sendingDiffCommentIdsRef.current.has(id))) {
        return
      }
      const setSending = (next: ReadonlySet<string>): void => {
        sendingDiffCommentIdsRef.current = next
        setSendingDiffCommentIds(next)
      }
      setSending(new Set([...sendingDiffCommentIdsRef.current, ...ids]))
      try {
        await launch()
      } finally {
        const next = new Set(sendingDiffCommentIdsRef.current)
        for (const id of ids) {
          next.delete(id)
        }
        setSending(next)
      }
    },
    []
  )

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
    sendingDiffCommentIds,
    sendDiffNotesToNewAgent,
    clearDeliveredDiffComments
  }
}

export type MobileSessionDiffCommentsModel = MobileSessionDocumentReadersModel &
  ReturnType<typeof useMobileSessionDiffComments>
