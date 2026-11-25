import { useEffect, useRef, useState } from 'react'
import type { MobileAutomation } from './automation-reply-schema'
import { automationDraftEdits, newAutomationDraft, type AutomationDraft } from './automation-draft'
import {
  discardAutomationEditorDraft,
  laySavedEdits,
  readAutomationEditorDraft,
  saveAutomationEditorDraft,
  watchAutomationEditorDraft
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

  useEffect(() => {
    return watchAutomationEditorDraft(draftKey, (edits) => {
      restored.current = edits
      setDraft((form) => laySavedEdits(form, original.current, edits))
    })
  }, [draftKey])

  useEffect(() => {
    saveAutomationEditorDraft(draftKey, automationDraftEdits(original.current, draft))
  }, [draft, draftKey])

  return {
    draft,
    setDraft,
    original,
    // The form rebuilt from the host's values, with the saved edits on top.
    withSavedEdits: (form: AutomationDraft): AutomationDraft => ({ ...form, ...restored.current }),
    discard: () => discardAutomationEditorDraft(draftKey)
  }
}
