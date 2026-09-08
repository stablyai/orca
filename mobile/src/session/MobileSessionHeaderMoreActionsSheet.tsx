import { useEffect, useState, useSyncExternalStore } from 'react'
import { Alert } from 'react-native'
import { ListChecks, Palette } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { PickerModal } from '../components/PickerModal'
import { terminalAppearanceText as t } from '../i18n/terminal-appearance'
import {
  getMobileTerminalThemeMode,
  loadMobileTerminalThemeMode,
  saveMobileTerminalThemeMode,
  subscribeMobileTerminalThemeMode,
  type MobileTerminalThemeMode
} from '../storage/terminal-theme-preference'
import { colors } from '../theme/mobile-theme'

type Props = {
  visible: boolean
  showAgentSessionHistory: boolean
  showChecks: boolean
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onClose: () => void
}

export function MobileSessionHeaderMoreActionsSheet({
  visible,
  showAgentSessionHistory,
  showChecks,
  onOpenAgentSessionHistory,
  onOpenChecks,
  onClose
}: Props) {
  const mode = useSyncExternalStore(
    subscribeMobileTerminalThemeMode,
    getMobileTerminalThemeMode,
    getMobileTerminalThemeMode
  )
  const [showThemePicker, setShowThemePicker] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (visible) {
      void loadMobileTerminalThemeMode().catch(() => Alert.alert(t('title'), t('loadError')))
    }
  }, [visible])

  return (
    <>
      <ActionSheetModal
        visible={visible}
        actions={[
          {
            label: t('title'),
            hint: t(mode),
            icon: Palette,
            loading: saving,
            closeBeforePress: true,
            onPress: () => setShowThemePicker(true)
          },
          ...(showAgentSessionHistory
            ? [
                {
                  label: t('history'),
                  hint: t('historyHint'),
                  renderIcon: () => (
                    <MobileAgentSessionHistoryIcon
                      size={16}
                      color={colors.textSecondary}
                      strokeWidth={2.1}
                    />
                  ),
                  onPress: onOpenAgentSessionHistory
                }
              ]
            : []),
          ...(showChecks
            ? [
                {
                  label: t('checks'),
                  hint: t('checksHint'),
                  icon: ListChecks,
                  onPress: onOpenChecks
                }
              ]
            : [])
        ]}
        onClose={onClose}
      />
      <PickerModal<MobileTerminalThemeMode>
        visible={showThemePicker}
        title={t('title')}
        selected={mode}
        options={(['system', 'dark', 'light', 'desktop'] as const).map((value) => ({
          value,
          label: t(value),
          subtitle:
            value === 'system'
              ? t('systemHint')
              : value === 'desktop'
                ? t('desktopHint')
                : undefined,
          disabled: saving
        }))}
        onSelect={(next) => {
          setSaving(true)
          void saveMobileTerminalThemeMode(next)
            .catch(() => Alert.alert(t('title'), t('saveError')))
            .finally(() => setSaving(false))
        }}
        onClose={() => setShowThemePicker(false)}
      />
    </>
  )
}
