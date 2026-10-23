import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { colors, spacing, textStyles } from '../../theme/mobile-theme'
import { Button } from './Button'

type StateAction = { label: string; onPress: () => void; busy?: boolean }

type StateViewProps = {
  /** Omitted while loading, which shows a spinner instead. */
  icon?: LucideIcon
  /** Says what is wrong or what is happening, e.g. "MacBook Pro is offline". */
  title: string
  /** Says what happens next or what to do. */
  message?: string
  primary?: StateAction
  secondary?: StateAction
  loading?: boolean
  testID?: string
}

/** Empty, loading, offline and error screens: icon, title, one sentence, at most two actions. */
export function StateView({
  icon: Icon,
  title,
  message,
  primary,
  secondary,
  loading = false,
  testID
}: StateViewProps) {
  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.body} accessibilityRole={loading ? 'progressbar' : undefined}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : Icon ? (
          <Icon size={32} color={colors.textMuted} strokeWidth={1.75} />
        ) : null}
        <Text style={loading ? styles.loadingTitle : styles.title}>{title}</Text>
        {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
        {primary || secondary ? (
          <View style={styles.actions}>
            {primary ? (
              <Button
                label={primary.label}
                onPress={primary.onPress}
                busy={primary.busy}
                variant="primary"
                size="compact"
              />
            ) : null}
            {secondary ? (
              <Button
                label={secondary.label}
                onPress={secondary.onPress}
                busy={secondary.busy}
                variant="plain"
                size="compact"
              />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl + 16 },
  body: { maxWidth: 300, alignItems: 'center', gap: 10 },
  title: {
    ...textStyles.title,
    fontSize: 20,
    lineHeight: 25,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 6
  },
  loadingTitle: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  message: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }
})
