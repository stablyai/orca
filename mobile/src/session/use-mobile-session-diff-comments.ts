import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { formatDiffComments } from '../../../src/shared/diff-comments-format'
import { useClipboardWriter } from '../platform/clipboard'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import type { SendRequestOptions } from '../transport/unvalidated-rpc-request-port'
import { sessionWorktreeRecordRead } from './mobile-session-read-operations'
import { sessionWorktreeNotesWrite } from './mobile-session-write-operations'
import { triggerSelection, triggerSuccess, triggerError } from '../platform/haptics'
import {
  addMobileDiffComment,
  normalizeMobileDiffComments,
  removeDeliveredMobileDiffComments,
  removeMobileDiffComments,
  sendableMobileDiffComments
} from './mobile-diff-comments'
import { mergeDiffCommentMutation } from '../../../src/shared/diff-comment-mutation'
import {
  createReviewNotesSync,
  enqueueReviewNotesRequest,
  reviewNotesView,
  type ReviewNotesSync
} from './mobile-review-notes-sync'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { DiffNotesDelivery } from './mobile-session-route-types'
import type { MobileSessionDocumentReadersModel } from './use-mobile-session-document-readers'

// Why: a queued request must not wait untimed for a reconnect and stall the notes behind it.
const NOTES_REQUEST_OPTIONS: SendRequestOptions = { failWhenDisconnected: true }
// Why: delivered notes must still clear after a reconnect, or they could be sent again.
const DELIVERED_CLEANUP_REQUEST_OPTIONS: SendRequestOptions = {}

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
  // Hold notes until prompt-delivery reply, beyond the create lock, so resend cannot launch another agent with the same notes.
  const sendingDiffCommentIdsRef = useRef<ReadonlySet<string>>(new Set())
  const [sendingDiffCommentIds, setSendingDiffCommentIds] = useState<ReadonlySet<string>>(
    sendingDiffCommentIdsRef.current
  )
  // Why: a reply or failure for another workspace or connection must not touch these notes.
  const notesSync = useMemo(() => createReviewNotesSync(), [client, worktreeId])
  const showDiffComments = useCallback(
    (sync: ReviewNotesSync): void => {
      if (!sync.active) {
        return
      }
      const comments = reviewNotesView(sync)
      // Why: a second tap in the same frame must build on this list, not the last rendered one.
      diffCommentsRef.current = comments
      setDiffComments(comments)
    },
    [diffCommentsRef, setDiffComments]
  )

  const loadDiffComments = useCallback((): Promise<void> => {
    const sync = notesSync
    return enqueueReviewNotesRequest(sync, async () => {
      if (!client || connState !== 'connected' || !worktreeId || isFloatingWorkspaceRoute) {
        sync.host = []
        showDiffComments(sync)
        return
      }
      const response = sessionWorktreeRecordRead.interpret(
        await sessionWorktreeRecordRead.request(
          client,
          { worktree: `id:${worktreeId}` },
          NOTES_REQUEST_OPTIONS
        )
      )
      if (response.accepted) {
        sync.host = normalizeMobileDiffComments(response.value?.diffComments, worktreeId)
        showDiffComments(sync)
      }
    })
  }, [client, connState, worktreeId, isFloatingWorkspaceRoute, notesSync, showDiffComments])

  // Shows `next` at once, then the host's merged list; on failure drops only this change.
  const saveDiffComments = useCallback(
    async (next: DiffComment[], options: SendRequestOptions = NOTES_REQUEST_OPTIONS) => {
      const sync = notesSync
      const save = { base: diffCommentsRef.current, next }
      sync.pending = [...sync.pending, save]
      showDiffComments(sync)
      try {
        await enqueueReviewNotesRequest(sync, async () => {
          if (!client || connState !== 'connected') {
            throw new Error('Waiting for desktop...')
          }
          // Why: send the host's list plus only this change; an older host stores the list whole.
          const base = sync.host
          const rebased = mergeDiffCommentMutation(save.base, base, save.next)
          const response = await sessionWorktreeNotesWrite.request(
            client,
            {
              worktree: `id:${worktreeId}`,
              diffComments: [...rebased],
              diffCommentsBase: [...base]
            },
            options
          )
          const saved = interpretOrThrowRefusalMessage(
            () => sessionWorktreeNotesWrite.interpret(response),
            'Failed to save review notes'
          )
          sync.pending = sync.pending.filter((pending) => pending !== save)
          sync.host =
            saved?.diffComments !== undefined
              ? normalizeMobileDiffComments(saved.diffComments, worktreeId)
              : rebased
          showDiffComments(sync)
        })
      } catch (err) {
        sync.pending = sync.pending.filter((pending) => pending !== save)
        showDiffComments(sync)
        throw err
      }
    },
    [client, connState, worktreeId, diffCommentsRef, notesSync, showDiffComments]
  )

  useEffect(() => {
    notesSync.active = true
    return () => {
      notesSync.active = false
    }
  }, [notesSync])

  useEffect(() => {
    // Catch at the fire-and-forget mount caller; the recording adapter still needs the loader’s rejection.
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
      setDiffCommentBusy(true)
      try {
        await saveDiffComments(result.comments)
        triggerSuccess()
        showToast('Note added')
        return true
      } catch (err) {
        triggerError()
        showToast(err instanceof Error ? err.message : 'Failed to save note', 1600)
        return false
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [diffCommentBusy, saveDiffComments, showToast, worktreeId]
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
      try {
        await saveDiffComments(next)
        triggerSelection()
      } catch (err) {
        triggerError()
        showToast(err instanceof Error ? err.message : 'Failed to delete note', 1600)
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [diffCommentBusy, saveDiffComments, showToast]
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
      try {
        await saveDiffComments(next, DELIVERED_CLEANUP_REQUEST_OPTIONS)
      } catch {
        // saveDiffComments already restored the delivered notes.
      } finally {
        setDiffCommentBusy(false)
      }
    },
    [saveDiffComments]
  )
  return {
    loadDiffComments,
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
