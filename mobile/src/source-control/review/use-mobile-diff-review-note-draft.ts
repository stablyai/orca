import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import type { DiffComment } from '../../../../src/shared/diff-comment-types'
import type { ReviewSheet, ReviewSheetIntents } from './mobile-diff-review-sheets'

type NoteDraftInput = {
  composerBody: string
  setComposerBody: Dispatch<SetStateAction<string>>
  openSheet: ReviewSheetIntents['openSheet']
}

type NewNoteSheet =
  | Extract<ReviewSheet, { kind: 'range' }>
  | { kind: 'composer'; composer: { mode: 'create'; lineNumber: number } }

/** The review's unsaved new note: kept across Cancel, reopen and picking other lines, cleared only once saved. */
export function useMobileDiffReviewNoteDraft({
  composerBody,
  setComposerBody,
  openSheet
}: NoteDraftInput) {
  // Set while an edit borrows the text field; the new note comes back when a new-note sheet opens.
  const setAsideNoteRef = useRef<string | null>(null)
  const openNewNoteSheet = useCallback(
    (sheet: NewNoteSheet) => {
      if (setAsideNoteRef.current !== null) {
        setComposerBody(setAsideNoteRef.current)
        setAsideNoteRef.current = null
      }
      openSheet(sheet)
    },
    [openSheet, setComposerBody]
  )

  // The user may have moved on while a note was saving; drop only the text that was saved.
  const clearSavedNote = useCallback(
    (saved: string) => {
      const isSaved = (text: string) => text.trim() === saved.trim()
      if (setAsideNoteRef.current === null) {
        setComposerBody((current) => (isSaved(current) ? '' : current))
      } else if (isSaved(setAsideNoteRef.current)) {
        setAsideNoteRef.current = ''
      }
    },
    [setComposerBody]
  )

  const openEditComposer = useCallback(
    (comment: DiffComment) => {
      setAsideNoteRef.current ??= composerBody
      openSheet({ kind: 'composer', composer: { mode: 'edit', comment } })
      setComposerBody(comment.body)
    },
    [composerBody, openSheet, setComposerBody]
  )

  return { openNewNoteSheet, openEditComposer, clearSavedNote }
}
