import { useEffect, useState, useSyncExternalStore } from 'react'
import { Alert } from 'react-native'
import { ListChecks, Palette } from 'lucide-react-native'
import { MobileAgentSessionHistoryIcon } from '../agent-history/MobileAgentSessionHistoryIcon'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { PickerModal } from '../components/PickerModal'
import {
  getMobileTerminalThemeMode,
  loadMobileTerminalThemeMode,
  saveMobileTerminalThemeMode,
  subscribeMobileTerminalThemeMode,
  type MobileTerminalThemeMode
} from '../storage/terminal-theme-preference'
import { colors } from '../theme/mobile-theme'

const APPEARANCE_TITLE = 'Terminal appearance'
const MODE_LABELS: Record<MobileTerminalThemeMode, string> = {
  system: 'Automatic (phone)',
  dark: 'Dark',
  light: 'Light',
  desktop: 'Match desktop'
}
const MODE_HINTS: Partial<Record<MobileTerminalThemeMode, string>> = {
  system: 'Follow your phone’s light or dark setting.',
  desktop: 'Use the connected desktop’s terminal colors.'
}

type Props = {
  visible: boolean
  showAgentSessionHistory: boolean
  showChecks: boolean
  onOpenAgentSessionHistory: () => void
  onOpenChecks: () => void
  onClose: () => void
}

/** Keeps device appearance controls available even when the host has no history or checks actions. */
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
      void loadMobileTerminalThemeMode().catch(() =>
        Alert.alert(APPEARANCE_TITLE, 'Couldn’t load your saved terminal appearance.')
      )
    }
  }, [visible])

  return (
    <>
      <ActionSheetModal
        visible={visible}
        actions={[
          {
            label: APPEARANCE_TITLE,
            hint: MODE_LABELS[mode],
            icon: Palette,
            loading: saving,
            closeBeforePress: true,
            onPress: () => setShowThemePicker(true)
          },
          ...(showAgentSessionHistory
            ? [
                {
                  label: 'Agent History',
                  hint: 'Browse and resume agent sessions',
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
                  label: 'Checks',
                  hint: 'Open pull request checks',
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
        title={APPEARANCE_TITLE}
        selected={mode}
        options={(['system', 'dark', 'light', 'desktop'] as const).map((value) => ({
          value,
          label: MODE_LABELS[value],
          subtitle: MODE_HINTS[value],
          disabled: saving
        }))}
        onSelect={(next) => {
          setSaving(true)
          void saveMobileTerminalThemeMode(next)
            .catch(() =>
              Alert.alert(
                APPEARANCE_TITLE,
                'Couldn’t save terminal appearance. Your selection applies until the app restarts.'
              )
            )
            .finally(() => setSaving(false))
        }}
        onClose={() => setShowThemePicker(false)}
      />
    </>
  )
}
