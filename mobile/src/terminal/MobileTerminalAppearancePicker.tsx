import { useEffect, useState, useSyncExternalStore } from 'react'
import { Alert } from 'react-native'
import { PickerModal } from '../components/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  getMobileTerminalThemeMode,
  loadMobileTerminalThemeMode,
  saveMobileTerminalThemeMode,
  subscribeMobileTerminalThemeMode,
  type MobileTerminalThemeMode
} from '../storage/terminal-theme-preference'

export function MobileTerminalAppearancePicker({
  visible,
  onClose
}: {
  visible: boolean
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const title = t('terminal.appearance.title', 'Terminal appearance')
  const mode = useSyncExternalStore(
    subscribeMobileTerminalThemeMode,
    getMobileTerminalThemeMode,
    getMobileTerminalThemeMode
  )
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (visible) {
      void loadMobileTerminalThemeMode().catch(() =>
        Alert.alert(
          title,
          t('terminal.appearance.loadFailed', 'Couldn’t load your saved terminal appearance.')
        )
      )
    }
  }, [visible, title, t])

  return (
    <PickerModal<MobileTerminalThemeMode>
      visible={visible}
      title={title}
      selected={mode}
      options={[
        {
          value: 'system',
          label: t('terminal.appearance.system', 'Automatic (phone)'),
          subtitle: t(
            'terminal.appearance.systemHint',
            'Follow your phone’s light or dark setting.'
          ),
          disabled: saving
        },
        { value: 'dark', label: t('terminal.appearance.dark', 'Dark'), disabled: saving },
        { value: 'light', label: t('terminal.appearance.light', 'Light'), disabled: saving },
        {
          value: 'desktop',
          label: t('terminal.appearance.desktop', 'Match desktop'),
          subtitle: t(
            'terminal.appearance.desktopHint',
            'Use the connected desktop’s terminal colors.'
          ),
          disabled: saving
        }
      ]}
      onSelect={(next) => {
        setSaving(true)
        void saveMobileTerminalThemeMode(next)
          .catch(() =>
            Alert.alert(
              title,
              t(
                'terminal.appearance.saveFailed',
                'Couldn’t save terminal appearance. Your selection applies until the app restarts.'
              )
            )
          )
          .finally(() => setSaving(false))
      }}
      onClose={onClose}
    />
  )
}
