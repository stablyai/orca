import { useCallback, useRef } from 'react'
import { Keyboard } from 'react-native'
import type { DirtyMarkdownDraft } from './session-document-state'

/** A leave that goes its own way (the menu's Delete) once the phone's unsaved drafts are settled.
 *  Only the drafts sheet's Copy or Discard takes it; closing the sheet or a plain Back drops it. */
export function useSessionLeaveHandoff(
  getDirtyMarkdownDrafts: () => DirtyMarkdownDraft[],
  setLeaveDrafts: (drafts: DirtyMarkdownDraft[] | null) => void
) {
  const handoffRef = useRef<(() => void) | null>(null)
  const takeLeaveHandoff = useCallback(() => {
    const handoff = handoffRef.current
    handoffRef.current = null
    return handoff ?? undefined
  }, [])
  // The same drafts check Back runs; dictation keeps recording across an in-page leave.
  const requestLeaveForHandoff = useCallback(
    (handoff: () => void) => {
      const dirtyDrafts = getDirtyMarkdownDrafts()
      if (dirtyDrafts.length === 0) {
        handoffRef.current = null
        handoff()
        return
      }
      Keyboard.dismiss()
      handoffRef.current = handoff
      setLeaveDrafts(dirtyDrafts)
    },
    [getDirtyMarkdownDrafts, setLeaveDrafts]
  )
  return { requestLeaveForHandoff, takeLeaveHandoff }
}
