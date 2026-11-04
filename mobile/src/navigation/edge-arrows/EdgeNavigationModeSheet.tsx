import { Modal, Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { EdgeNavigationMode } from './edge-navigation-preference'
import { screenEdgeNavigationStyles as styles } from './screen-edge-navigation-styles'

export function EdgeNavigationModeSheet({
  visible,
  mode,
  switcherChipHidden,
  onSelectMode,
  onToggleSwitcherChip,
  onClose
}: {
  visible: boolean
  mode: EdgeNavigationMode
  switcherChipHidden: boolean
  onSelectMode: (mode: EdgeNavigationMode) => void
  onToggleSwitcherChip: (hidden: boolean) => void
  onClose: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()

  const options: { key: EdgeNavigationMode; label: string }[] = [
    {
      key: 'pills',
      label: t('navigation.edgeArrows.modePillsOption', 'Edge Pills (glassmorphic capsules)')
    },
    {
      key: 'strips',
      label: t('navigation.edgeArrows.modeStripsOption', 'Edge Strips (wide touch rails)')
    },
    {
      key: 'orbs',
      label: t('navigation.edgeArrows.modeOrbsOption', 'Floating Orbs (compact buttons)')
    },
    {
      key: 'off',
      label: t('navigation.edgeArrows.modeOffOption', 'Off (hide 4-side edge arrows)')
    }
  ]

  const toggleChipLabel = switcherChipHidden
    ? t('navigation.edgeArrows.showSwitcherChip', 'Show quick-switcher chip')
    : t('navigation.edgeArrows.hideSwitcherChip', 'Hide quick-switcher chip')

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheetCard}>
          <Text style={styles.sheetTitle}>
            {t('navigation.edgeArrows.sheetTitle', '4-side edge arrows')}
          </Text>
          <Text style={styles.sheetMessage}>
            {t(
              'navigation.edgeArrows.sheetMessage',
              'Choose how sticky navigation arrows appear inside terminal, agent session, and content windows.'
            )}
          </Text>

          {options.map((option) => {
            const selected = mode === option.key
            return (
              <Pressable
                key={option.key}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                onPress={() => {
                  onSelectMode(option.key)
                  onClose()
                }}
                style={({ pressed }) => [
                  styles.sheetOption,
                  selected && styles.sheetOptionSelected,
                  pressed && styles.sheetOptionPressed
                ]}
              >
                <Text style={styles.sheetOptionLabel}>{option.label}</Text>
                {selected ? <Text style={styles.sheetOptionCheck}>✓</Text> : null}
              </Pressable>
            )
          })}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={toggleChipLabel}
            onPress={() => {
              onToggleSwitcherChip(!switcherChipHidden)
              onClose()
            }}
            style={({ pressed }) => [styles.sheetOption, pressed && styles.sheetOptionPressed]}
          >
            <Text style={styles.sheetOptionLabel}>{toggleChipLabel}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.close', 'Close')}
            onPress={onClose}
            style={({ pressed }) => [styles.sheetCancel, pressed && styles.sheetOptionPressed]}
          >
            <Text style={styles.sheetCancelText}>{t('common.close', 'Close')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}
