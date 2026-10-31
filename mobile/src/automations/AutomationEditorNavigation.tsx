import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { AutomationButton } from './AutomationControls'
import { automationStyles as styles } from './automation-styles'

type EditorPosition = { step: number; editing: boolean; busy: boolean }

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
