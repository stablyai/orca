import { useCallback, useState, type SetStateAction } from 'react'
import type { DiffComment } from '../../../../../src/shared/diff-comment-types'
import { useDurableDraftField } from '../../../drafts/durable-draft-fields'
import type { ReviewSheet, ReviewSheetIntents } from '../diff-actions/mobile-diff-review-sheets'

type NoteDraftInput = {
  // Where the new note waits through leaving the review and the app being killed.
  draftKey: string
  openSheet: ReviewSheetIntents['openSheet']
}

type NewNoteSheet =
  | Extract<ReviewSheet, { kind: 'range' }>
  | { kind: 'composer'; composer: { mode: 'create'; lineNumber: number } }

/** The review's unsaved new note: kept across Cancel, reopen and picking other lines, cleared only once saved. */
export function useMobileDiffReviewNoteDraft({ draftKey, openSheet }: NoteDraftInput) {
  const [newNote, setNewNote] = useDurableDraftField(draftKey, 'note')
  // An edit borrows the text field with its own text, until a new-note sheet opens; the new note is untouched
  // underneath. Kept past the edit sheet closing, so its text stays while it slides away.
  const [editBody, setEditBody] = useState<string | null>(null)
  const setEditText = useCallback(
    (next: SetStateAction<string>) =>
      setEditBody((current) => (typeof next === 'function' ? next(current ?? '') : next)),
    []
  )

  const openNewNoteSheet = useCallback(
    (sheet: NewNoteSheet) => {
      setEditBody(null)
      openSheet(sheet)
    },
    [openSheet]
  )

  // The user may have moved on while a note was saving; drop only the text that was saved.
  const clearSavedNote = useCallback(
    (saved: string) => setNewNote((current) => (current.trim() === saved.trim() ? '' : current)),
    [setNewNote]
  )

  const openEditComposer = useCallback(
    (comment: DiffComment) => {
      openSheet({ kind: 'composer', composer: { mode: 'edit', comment } })
      setEditBody(comment.body)
    },
    [openSheet]
  )

  return {
    composerBody: editBody ?? newNote,
    setComposerBody: editBody === null ? setNewNote : setEditText,
    openNewNoteSheet,
    openEditComposer,
    clearSavedNote
  }
}

export type MobileDiffReviewNoteDraft = ReturnType<typeof useMobileDiffReviewNoteDraft>
