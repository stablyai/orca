import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useClipboardWriter } from '../platform/clipboard'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
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
import {
  createMobileReviewNoteMutationOwner,
  createReviewNotesBaseline,
  enqueueMobileReviewNoteMutation
} from './mobile-review-note-mutation-owner'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { DiffNotesDelivery } from './mobile-session-route-types'
import type { MobileSessionDocumentReadersModel } from './use-mobile-session-document-readers'

export function useMobileSessionDiffComments(scope: MobileSessionDocumentReadersModel) {
  const {
    worktreeId,
    hostId,
    isFloatingWorkspaceRoute,
    client,
    connState,
    setDiffComments,
    diffCommentsRef,
    setDiffCommentBusy,
    setPendingDiffNotesDelivery,
    showToast
  } = scope
  const clipboard = useClipboardWriter()
  const executionHost = useWorkspaceExecutionHost()
  // Why: a new agent's reply can outlast the "+" lock by a minute, and resending notes it still
  // carries would start a second agent with them. Held from the tap until that reply settles.
  const sendingDiffCommentIdsRef = useRef<ReadonlySet<string>>(new Set())
  const [sendingDiffCommentIds, setSendingDiffCommentIds] = useState<ReadonlySet<string>>(
    sendingDiffCommentIdsRef.current
  )
  const notesOwner = useMemo(
    () => createMobileReviewNoteMutationOwner(),
    [hostId, worktreeId, executionHost, isFloatingWorkspaceRoute]
  )
  const publishComments = useCallback(
    (comments: DiffComment[]) => {
      if (notesOwner.active) {
        diffCommentsRef.current = comments
        setDiffComments(comments)
      }
    },
    [diffCommentsRef, notesOwner, setDiffComments]
  )
  const enqueueMutation = useCallback(
    function enqueueMutation<T>(mutate: () => Promise<T>, inactive: T): Promise<T> {
      return enqueueMobileReviewNoteMutation(notesOwner, mutate, inactive, setDiffCommentBusy, () =>
        showToast('Unable to load review notes. Reconnect before editing.', 1600)
      )
    },
    [notesOwner, setDiffCommentBusy, showToast]
  )
  const loadDiffComments = useCallback(async (): Promise<void> => {
    const loadRevision = ++notesOwner.loadRevision
    const notesRevision = notesOwner.revision
    if (!notesOwner.baselineLoaded && notesOwner.baseline.settled) {
      notesOwner.baseline = createReviewNotesBaseline()
    }
    const finishBaseline = (available: boolean) => {
      if (!notesOwner.baselineLoaded) {
        notesOwner.baselineLoaded = available
        notesOwner.baseline.settled = true
        notesOwner.baseline.resolve(available)
      }
    }
    if (!notesOwner.baselineLoaded) {
      publishComments([])
    }
    if (!client || connState !== 'connected' || !worktreeId || isFloatingWorkspaceRoute) {
      finishBaseline(false)
      return
    }
    try {
      const response = sessionWorktreeRecordRead.interpret(
        await sessionWorktreeRecordRead.request(client, { worktree: `id:${worktreeId}` })
      )
      if (!notesOwner.active || loadRevision !== notesOwner.loadRevision) {
        return
      }
      if (!response.accepted || response.value === undefined) {
        finishBaseline(false)
        return
      }
      if (!notesOwner.baselineLoaded) {
        publishComments(normalizeMobileDiffComments(response.value?.diffComments, worktreeId))
        finishBaseline(true)
        return
      }
      if (notesRevision === notesOwner.revision && notesOwner.pending === 0) {
        publishComments(normalizeMobileDiffComments(response.value?.diffComments, worktreeId))
      }
    } catch (error) {
      if (notesOwner.active && loadRevision === notesOwner.loadRevision) {
        finishBaseline(false)
      }
      throw error
    }
  }, [client, connState, worktreeId, isFloatingWorkspaceRoute, notesOwner, publishComments])

  const persistDiffComments = useCallback(
    async (comments: readonly DiffComment[]): Promise<void> => {
      if (!notesOwner.active || !client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      notesOwner.revision += 1
      notesOwner.pending += 1
      try {
        const response = await sessionWorktreeNotesWrite.request(client, {
          worktree: `id:${worktreeId}`,
          diffComments: [...comments]
        })
        interpretOrThrowRefusalMessage(
          () => sessionWorktreeNotesWrite.interpret(response),
          'Failed to save review notes'
        )
      } finally {
        notesOwner.pending -= 1
        notesOwner.revision += 1
      }
    },
    [client, connState, worktreeId, notesOwner]
  )

  useEffect(() => {
    // Caught here and not in the loader: a *rejected* `worktree.show` would otherwise be an
    // unhandled rejection on every mount, and the loader's own promise is awaited by the recording
    // adapter, which a swallowed rejection inside it would hide.
    notesOwner.active = true
    setDiffCommentBusy(notesOwner.pending > 0)
    void loadDiffComments().catch(() => undefined)
    return () => {
      notesOwner.loadRevision += 1
    }
  }, [loadDiffComments, notesOwner, setDiffCommentBusy])

  useEffect(
    () => () => {
      notesOwner.active = false
      notesOwner.baseline.settled = true
      notesOwner.baseline.resolve(false)
    },
    [notesOwner]
  )

  const addDiffCommentForFile = useCallback(
    (filePath: string, lineNumber: number, body: string): Promise<boolean> =>
      enqueueMutation(async () => {
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
        publishComments(result.comments)
        try {
          await persistDiffComments(result.comments)
          if (notesOwner.active) {
            triggerSuccess()
            showToast('Note added')
          }
          return true
        } catch (err) {
          publishComments(previous)
          if (notesOwner.active) {
            triggerError()
            showToast(err instanceof Error ? err.message : 'Failed to save note', 1600)
          }
          return false
        }
      }, false),
    [
      diffCommentsRef,
      enqueueMutation,
      notesOwner,
      persistDiffComments,
      publishComments,
      showToast,
      worktreeId
    ]
  )

  const deleteDiffCommentForFile = useCallback(
    (commentId: string): Promise<void> =>
      enqueueMutation(async () => {
        const previous = diffCommentsRef.current
        const next = removeMobileDiffComments(previous, new Set([commentId]))
        if (next.length === previous.length) {
          return
        }
        publishComments(next)
        try {
          await persistDiffComments(next)
          if (notesOwner.active) {
            triggerSelection()
          }
        } catch (err) {
          publishComments(previous)
          if (notesOwner.active) {
            triggerError()
            showToast(err instanceof Error ? err.message : 'Failed to delete note', 1600)
          }
        }
      }, undefined),
    [diffCommentsRef, enqueueMutation, notesOwner, persistDiffComments, publishComments, showToast]
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
    (delivered: readonly DiffComment[]): Promise<void> =>
      enqueueMutation(async () => {
        const previous = diffCommentsRef.current
        const next = removeDeliveredMobileDiffComments(previous, delivered)
        if (next.length === previous.length) {
          return
        }
        publishComments(next)
        try {
          await persistDiffComments(next)
        } catch {
          publishComments(previous)
        }
      }, undefined),
    [diffCommentsRef, enqueueMutation, persistDiffComments, publishComments]
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
