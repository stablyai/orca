import { useEffect, type RefObject } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { automationDraftChanged, type AutomationDraft } from './automation-draft'
import type { PresentAutomationSheet } from './AutomationSheets'

/** Runs `leave` at once, or once the user agrees to discard unsaved edits. */
export type AutomationLeaveGuard = (leave: () => void) => void
export type AutomationLeaveSlot = RefObject<AutomationLeaveGuard | null>

export function leaveThrough(slot: AutomationLeaveSlot | undefined, leave: () => void): void {
  if (slot?.current) {
    slot.current(leave)
  } else {
    leave()
  }
}

/** Asks before a leave drops unsaved edits; fills `slot` while mounted so the host switch asks too. */
export function useAutomationLeaveGuard(
  draft: AutomationDraft,
  original: RefObject<AutomationDraft>,
  slot: AutomationLeaveSlot | undefined,
  onDiscard: () => void,
  present: PresentAutomationSheet
) {
  const t = useMobileTranslation()
  const changed = automationDraftChanged(original.current, draft)
  const guard: AutomationLeaveGuard = (leave) => {
    if (!changed) {
      leave()
      return
    }
    present({
      kind: 'confirm',
      title: t('automations.mobile.discardChangesTitle', 'Discard changes?'),
      message: t(
        'automations.mobile.discardChangesMessage',
        'Unsaved edits to this automation will be lost.'
      ),
      confirmLabel: t('automations.mobile.discard', 'Discard'),
      cancelLabel: t('automations.mobile.keepEditing', 'Keep editing'),
      destructive: true,
      onConfirm: () => {
        onDiscard()
        leave()
      }
    })
  }
  useEffect(() => {
    if (!slot) {
      return
    }
    slot.current = guard
    return () => {
      slot.current = null
    }
  })
  return { guard, changed }
}
