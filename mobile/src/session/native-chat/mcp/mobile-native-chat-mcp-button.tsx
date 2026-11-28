import { MobilePendingButton } from '../../../components/controls/MobilePendingButton'
import { useThemedStyles } from '../../../theme/themed-styles'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { mcpPanelStylesSheet as stylesSheet } from './mobile-native-chat-mcp-panel-styles'

/** A `/mcp` tray button: primary, secondary or plain. */
export function McpButton({
  label,
  tone,
  tall = false,
  busy = false,
  disabled = false,
  onPress
}: {
  label: string
  tone: 'primary' | 'secondary' | 'plain'
  tall?: boolean
  busy?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  return (
    <MobilePendingButton
      label={label}
      pending={busy}
      disabled={disabled}
      onPress={onPress}
      hitSlop={tall ? undefined : 6}
      style={[
        styles.button,
        tall && styles.buttonTall,
        tone === 'primary' && styles.buttonPrimary,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'plain' && styles.buttonPlain
      ]}
      labelStyle={[
        styles.buttonLabel,
        tone === 'primary' && styles.buttonLabelPrimary,
        tone === 'plain' && styles.buttonLabelPlain
      ]}
      spinnerColor={tone === 'primary' ? colors.bgBase : colors.textPrimary}
    />
  )
}
