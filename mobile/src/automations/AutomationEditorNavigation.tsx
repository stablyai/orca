import { useEffect, useState, type RefObject } from 'react'
import { Text, View } from 'react-native'
import { ConfirmModal } from '../components/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { AutomationButton } from './AutomationControls'
import { automationDraftChanged, type AutomationDraft } from './automation-draft'
import { automationStyles as styles } from './automation-styles'

type EditorPosition = { step: number; editing: boolean; busy: boolean }
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

/** Asks before a leave drops unsaved edits; fills `slot` while mounted so the tab and host switches ask too. */
export function useAutomationLeaveGuard(
  draft: AutomationDraft,
  original: RefObject<AutomationDraft>,
  slot: AutomationLeaveSlot | undefined,
  onDiscard: () => void
) {
  const t = useMobileTranslation()
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const guard: AutomationLeaveGuard = (leave) => {
    if (automationDraftChanged(original.current, draft)) {
      setPendingLeave(() => leave)
    } else {
      leave()
    }
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
  const confirm = (
    <ConfirmModal
      visible={pendingLeave !== null}
      title={t('automations.mobile.discardChangesTitle', 'Discard changes?')}
      message={t(
        'automations.mobile.discardChangesMessage',
        'Unsaved edits to this automation will be lost.'
      )}
      confirmLabel={t('automations.mobile.discard', 'Discard')}
      cancelLabel={t('automations.mobile.keepEditing', 'Keep editing')}
      destructive
      onConfirm={() => {
        onDiscard()
        pendingLeave?.()
      }}
      onCancel={() => setPendingLeave(null)}
    />
  )
  return { guard, confirm }
}

export function AutomationEditorHeader({
  step,
  editing,
  busy,
  onCancel
}: EditorPosition & { onCancel: () => void }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <View style={styles.row}>
        <Text style={[styles.title, styles.grow]}>
          {editing
            ? t('automations.mobile.editAutomation', 'Edit automation')
            : t('automations.mobile.newAutomation', 'New automation')}
        </Text>
        <AutomationButton
          label={t('automations.mobile.cancel', 'Cancel')}
          onPress={onCancel}
          disabled={busy}
        />
      </View>
      <Text style={styles.meta}>
        {t('automations.mobile.editorStep', '{{step}} of 3 · {{section}}', {
          step,
          section:
            step === 1
              ? t('automations.mobile.task', 'Task')
              : step === 2
                ? t('automations.mobile.schedule', 'Schedule')
                : t('automations.mobile.review', 'Review')
        })}
      </Text>
    </>
  )
}

export function AutomationEditorNavigation({
  step,
  editing,
  busy,
  disabled,
  onBack,
  onNext
}: EditorPosition & { disabled: boolean; onBack: () => void; onNext: () => void }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.row}>
      {step > 1 ? (
        <AutomationButton
          label={t('automations.mobile.back', 'Back')}
          onPress={onBack}
          disabled={busy}
        />
      ) : null}
      <View style={styles.grow}>
        <AutomationButton
          label={
            step < 3
              ? t('automations.mobile.continue', 'Continue')
              : editing
                ? t('automations.mobile.saveChanges', 'Save changes')
                : t('automations.mobile.createAutomation', 'Create automation')
          }
          primary
          onPress={onNext}
          disabled={disabled}
        />
      </View>
    </View>
  )
}
