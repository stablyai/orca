import { View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  isEdgeSwitcherChipHidden,
  resolveEdgeNavigationMode,
  setTerminalEdgeNavigationMode,
  setTerminalEdgeSwitcherChipHidden,
  type EdgeNavigationMode
} from '../navigation/edge-arrows/edge-navigation-preference'
import { SettingsSection } from '../settings/settings-screen-frame'
import type { TerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { ListRow } from './list/ListGroup'
import { MobileSegmentedControl } from './MobileSegmentedControl'
import { MobileSwitch } from './MobileSwitch'

const styles = themedStyleSheet(() => ({
  controlRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  }
}))

export function EdgeNavigationSettingsSection({
  shortcutLayout,
  onChangeLayout
}: {
  shortcutLayout: TerminalAccessoryLayout
  onChangeLayout: (updater: (current: TerminalAccessoryLayout) => TerminalAccessoryLayout) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()

  return (
    <SettingsSection
      title={t('components.terminalShortcutSettings.edgeArrowsSection', '4-SIDE EDGE ARROWS')}
      footer={t(
        'components.terminalShortcutSettings.edgeArrowsDescription',
        'Render sticky navigation arrows at all four inner edges of terminal, agent session, and content windows.'
      )}
    >
      <View style={styles.controlRow}>
        <MobileSegmentedControl<EdgeNavigationMode>
          fill
          testIDPrefix="edge-arrows-mode-"
          selected={resolveEdgeNavigationMode(shortcutLayout)}
          onSelect={(nextMode) =>
            onChangeLayout((current) => setTerminalEdgeNavigationMode(current, nextMode))
          }
          segments={[
            {
              value: 'pills',
              label: t('navigation.edgeArrows.pillsShort', 'Pills'),
              accessibilityLabel: t('navigation.edgeArrows.pillsLabel', 'Edge Pills')
            },
            {
              value: 'strips',
              label: t('navigation.edgeArrows.stripsShort', 'Strips'),
              accessibilityLabel: t('navigation.edgeArrows.stripsLabel', 'Edge Strips')
            },
            {
              value: 'orbs',
              label: t('navigation.edgeArrows.orbsShort', 'Orbs'),
              accessibilityLabel: t('navigation.edgeArrows.orbsLabel', 'Floating Orbs')
            },
            {
              value: 'off',
              label: t('navigation.edgeArrows.offShort', 'Off'),
              accessibilityLabel: t('navigation.edgeArrows.offLabel', 'Off')
            }
          ]}
        />
      </View>
      <ListRow
        key="edgeSwitcherChip"
        title={t(
          'components.terminalShortcutSettings.edgeSwitcherChip',
          'Show quick-switcher chip'
        )}
        subtitle={t(
          'components.terminalShortcutSettings.edgeSwitcherChipDescription',
          'Tap the top-right pane badge to cycle Pills, Strips, and Orbs live'
        )}
        accessory={
          <MobileSwitch
            accessibilityLabel={t(
              'components.terminalShortcutSettings.edgeSwitcherChip',
              'Show quick-switcher chip'
            )}
            value={!isEdgeSwitcherChipHidden(shortcutLayout)}
            onValueChange={(visible) =>
              onChangeLayout((current) => setTerminalEdgeSwitcherChipHidden(current, !visible))
            }
          />
        }
      />
    </SettingsSection>
  )
}
