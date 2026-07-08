import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitPullRequestArrow } from 'lucide-react-native'
import type { MobileCreatePrAction } from './mobile-create-pr-action'
import { createMobileSourceControlStyles } from './mobile-source-control-styles'
import { useThemedStyles, useTheme } from '../theme/theme-context'

type Props = {
  action: MobileCreatePrAction
}

export function MobileSourceControlCreatePrEntry({ action }: Props) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createMobileSourceControlStyles)
  if (!action.visible) {
    return null
  }
  const enabled = !action.disabled
  return (
    <View style={styles.createPrBlock}>
      <Pressable
        style={({ pressed }) => [
          styles.createPrButton,
          !enabled && styles.createPrButtonDisabled,
          pressed && enabled && styles.createPrButtonPressed
        ]}
        disabled={action.disabled}
        onPress={action.onPress}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        accessibilityHint={action.hint}
      >
        {action.loading ? (
          <ActivityIndicator size="small" color={enabled ? colors.bgBase : colors.textSecondary} />
        ) : (
          <GitPullRequestArrow
            size={16}
            color={enabled ? colors.bgBase : colors.textSecondary}
            strokeWidth={2.2}
          />
        )}
        <Text style={[styles.createPrButtonText, !enabled && styles.createPrButtonTextDisabled]}>
          {action.label}
        </Text>
      </Pressable>
      {action.hint ? (
        <Text style={styles.createPrHint} numberOfLines={2}>
          {action.hint}
        </Text>
      ) : null}
    </View>
  )
}
