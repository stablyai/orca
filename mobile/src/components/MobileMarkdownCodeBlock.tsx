import { memo, useMemo, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { Check, Copy } from 'lucide-react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { createThemedStyles } from '../theme/mobile-themed-styles'
import { useMobileTheme } from '../theme/use-mobile-theme'
import { highlightMobileCode } from './mobile-code-highlight'
import { mobileCodeTokenStyle } from './mobile-code-highlight-theme'

type Props = {
  selectable?: boolean
  code: string
  language?: string
  fontSize?: number
  lineHeight?: number
  style?: StyleProp<ViewStyle>
}

export const MobileMarkdownCodeBlock = memo(function MobileMarkdownCodeBlock({
  code,
  selectable = true,
  language,
  fontSize = 12,
  lineHeight = fontSize + 5,
  style
}: Props) {
  const scheme = useMobileTheme()
  const clipboard = useClipboardWriter()
  const [copyResult, setCopyResult] = useState<{ code: string; ok: boolean } | null>(null)
  const tokens = useMemo(() => highlightMobileCode(code, language), [code, language])
  const numbers = useMemo(
    () =>
      Array.from({ length: code.split('\n').length }, (_, index) => String(index + 1)).join('\n'),
    [code]
  )
  const copied = copyResult?.code === code && copyResult.ok
  const failed = copyResult?.code === code && !copyResult.ok
  const Icon = copied ? Check : Copy
  async function copy() {
    try {
      await clipboard.writeText(code)
      setCopyResult({ code, ok: true })
    } catch {
      setCopyResult({ code, ok: false })
    }
  }
  const metrics = { fontSize, lineHeight }
  return (
    <View style={[styles.root, style]}>
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.language}>
          {language || 'Code'}
        </Text>
        <View style={styles.copyStatus}>
          {failed ? (
            <Text accessibilityRole="alert" style={styles.error}>
              Copy failed
            </Text>
          ) : null}
          <Pressable
            onPress={() => void copy()}
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Code copied' : 'Copy code'}
            accessibilityHint="Copies code without line numbers"
            hitSlop={4}
            style={styles.copy}
          >
            <Icon size={14} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>
      <View style={styles.body}>
        <Text
          selectable={false}
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.numbers, metrics]}
        >
          {numbers}
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          nestedScrollEnabled
          style={styles.scroll}
        >
          <Text
            selectable={selectable}
            style={[
              styles.code,
              metrics,
              { color: mobileCodeTokenStyle([], scheme).color, minHeight: lineHeight }
            ]}
          >
            {tokens.map((token) => (
              <Text key={token.offset ?? 0} style={mobileCodeTokenStyle(token.classes, scheme)}>
                {token.text}
              </Text>
            ))}
          </Text>
        </ScrollView>
      </View>
    </View>
  )
})

const styles = createThemedStyles(() =>
  StyleSheet.create({
    root: {
      alignSelf: 'stretch',
      minWidth: 0,
      backgroundColor: colors.bgRaised,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: radii.input,
      overflow: 'hidden'
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: spacing.md,
      paddingRight: 4,
      minHeight: 40,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle
    },
    language: {
      fontSize: typography.metaSize,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      flexShrink: 1
    },
    copyStatus: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    copy: { minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
    error: { fontSize: 10, color: colors.statusRed },
    body: { flexDirection: 'row', paddingVertical: spacing.md },
    numbers: {
      fontFamily: typography.monoFamily,
      color: colors.textMuted,
      textAlign: 'right',
      paddingHorizontal: spacing.sm,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.borderSubtle,
      includeFontPadding: false
    },
    scroll: { flex: 1 },
    code: {
      fontFamily: typography.monoFamily,
      paddingHorizontal: spacing.sm,
      includeFontPadding: false
    }
  })
)
