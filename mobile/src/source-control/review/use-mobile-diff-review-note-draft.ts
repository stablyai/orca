import { useCallback, useState } from 'react'
import type { DiffComment } from '../../../../src/shared/diff-comment-types'
import { useDurableDraftField } from '../../drafts/durable-draft-fields'
import type { ComposerState } from './mobile-diff-review-screen-model'
import type { ReviewSheet, ReviewSheetIntents } from './mobile-diff-review-sheets'

type NoteDraftInput = {
  // Where the new note waits through leaving the review and the app being killed.
  draftKey: string
  composer: ComposerState | null
  openSheet: ReviewSheetIntents['openSheet']
}

type NewNoteSheet =
  | Extract<ReviewSheet, { kind: 'range' }>
  | { kind: 'composer'; composer: { mode: 'create'; lineNumber: number } }

/** The review's unsaved new note: kept across Cancel, reopen and picking other lines, cleared only once saved. */
export function useMobileDiffReviewNoteDraft({ draftKey, composer, openSheet }: NoteDraftInput) {
  const [newNote, setNewNote] = useDurableDraftField(draftKey, 'note')
  // An edit borrows the text field with its own text; the new note is untouched underneath.
  const [editBody, setEditBody] = useState('')
  const editing = composer?.mode === 'edit'

  const openNewNoteSheet = useCallback((sheet: NewNoteSheet) => openSheet(sheet), [openSheet])

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
    composerBody: editing ? editBody : newNote,
    setComposerBody: editing ? setEditBody : setNewNote,
    openNewNoteSheet,
    openEditComposer,
    clearSavedNote
  }
}

export type MobileDiffReviewNoteDraft = ReturnType<typeof useMobileDiffReviewNoteDraft>
