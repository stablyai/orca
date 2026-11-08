import { useEffect, useRef, useState } from 'react'
import type { MobileAutomation } from './automation-reply-schema'
import {
  automationDraftChanged,
  newAutomationDraft,
  type AutomationDraft
} from './automation-draft'
import {
  automationDraftEdits,
  loadAutomationEditorDraft,
  readAutomationEditorDraft,
  saveAutomationEditorDraft
} from './automation-editor-draft-row'

/** The editor's form, with the user's unsaved edits kept in a draft row and laid back over it on reopen. */
export function useAutomationEditorDraft(
  draftKey: string,
  current: MobileAutomation | undefined,
  initialDraft: AutomationDraft | undefined
) {
  const [saved] = useState(() => (initialDraft ? null : readAutomationEditorDraft(draftKey)))
  const restored = useRef(saved)
  const [draft, setDraft] = useState(
    () => initialDraft ?? { ...newAutomationDraft(current), ...saved }
  )
  const original = useRef(newAutomationDraft(current))
  // Set once the edits were discarded, so nothing writes them back.
  const retired = useRef(false)

  useEffect(() => {
    if (restored.current || initialDraft) {
      return
    }
    let active = true
    void loadAutomationEditorDraft(draftKey).then((edits) => {
      if (!active || !edits) {
        return
      }
      restored.current = edits
      setDraft((form) =>
        automationDraftChanged(original.current, form) ? form : { ...form, ...edits }
      )
    })
    return () => {
      active = false
    }
  }, [draftKey, initialDraft])

  useEffect(() => {
    if (!retired.current) {
      saveAutomationEditorDraft(draftKey, automationDraftEdits(original.current, draft))
    }
  }, [draft, draftKey])

  return {
    draft,
    setDraft,
    original,
    // The form rebuilt from the host's values, with the saved edits on top.
    withSavedEdits: (form: AutomationDraft): AutomationDraft => ({ ...form, ...restored.current }),
    discard: () => {
      retired.current = true
      saveAutomationEditorDraft(draftKey, null)
    }
  }
}
