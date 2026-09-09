import { StyleSheet, Text, View } from 'react-native'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react-native'
import type { NativeChatTextBlock } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function MobileNativeChatNoticeRow({
  block,
  fontScale
}: {
  block: NativeChatTextBlock
  fontScale: number
}): React.JSX.Element {
  const error = block.tone === 'error'
  const warning = block.tone === 'warning'
  const Icon = error ? AlertCircle : warning ? AlertTriangle : Info
  const color = error ? colors.statusRed : warning ? colors.statusAmber : colors.textMuted
  const label = error ? 'System error' : warning ? 'System warning' : 'System notice'
  return (
    <View style={styles.notice}>
      <View style={styles.heading}>
        <Icon size={typography.bodySize} color={color} />
        <Text style={[styles.label, { color, fontSize: typography.bodySize * fontScale }]}>
          {label}
        </Text>
      </View>
      <MobileMarkdown content={block.text} textScale={1.25 * fontScale} />
    </View>
  )
}

const styles = StyleSheet.create({
  notice: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radii.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { fontWeight: '500' }
})
