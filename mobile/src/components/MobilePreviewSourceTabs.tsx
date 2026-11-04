import { Pressable, Text, View } from 'react-native'
import { Code, Eye } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export type MobilePreviewMode = 'preview' | 'source'

type Props = {
  mode: MobilePreviewMode
  onModeChange: (mode: MobilePreviewMode) => void
  previewLabel: string
  sourceLabel: string
}

export function MobilePreviewSourceTabs({ mode, onModeChange, previewLabel, sourceLabel }: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    // Expose selected tab to assistive readers; active styling alone is silent.
    <View style={styles.toolbar} accessibilityRole="tablist">
      <Pressable
        style={[styles.toggle, mode === 'preview' && styles.toggleActive]}
        onPress={() => onModeChange('preview')}
        accessibilityRole="tab"
        // Set both native accessibilityState and web aria-selected: RN Web drops former without emitting latter.
        accessibilityState={{ selected: mode === 'preview' }}
        aria-selected={mode === 'preview'}
        accessibilityLabel={previewLabel}
      >
        <Eye size={13} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={styles.toggleText}>{t('components.htmlPreview.preview', 'Preview')}</Text>
      </Pressable>
      <Pressable
        style={[styles.toggle, mode === 'source' && styles.toggleActive]}
        onPress={() => onModeChange('source')}
        accessibilityRole="tab"
        accessibilityState={{ selected: mode === 'source' }}
        aria-selected={mode === 'source'}
        accessibilityLabel={sourceLabel}
      >
        <Code size={13} color={colors.textSecondary} strokeWidth={2.2} />
        <Text style={styles.toggleText}>{t('components.htmlPreview.source', 'Source')}</Text>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  toolbar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  toggleActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  toggleText: { color: colors.textSecondary, fontSize: typography.metaSize }
}))
