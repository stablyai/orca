import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, ExternalLink, RefreshCw, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-source-control-styles'

type Props = {
  embedded: boolean
  worktreeLabel: string
  ioBusy: boolean
  /** Pops the route. The embedded dock does not pop anything, which is why `onClose` is separate. */
  onBack: () => void
  /** Dismisses the dock beside the terminal, which is a close and must not be called Back. */
  onClose: () => void
  onRefresh: () => void
  // When set (PR segment ready with a host URL), show open-on-web flush-right of
  // the title so the control stays visible while the PR body scrolls.
  onOpenPrWeb?: () => void
  prNumber?: number | null
}

export function MobileSourceControlHeader({
  embedded,
  worktreeLabel,
  ioBusy,
  onBack,
  onClose,
  onRefresh,
  onOpenPrWeb,
  prNumber = null
}: Props) {
  return (
    <View style={styles.topBar}>
      {/* Two controls, not one with a conditional label: the dock's dismiss is a close, and a
          single control serving both modes has to be named Back in a mode where it closes. */}
      {embedded ? (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Close source control"
        >
          <X size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to session"
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      )}
      <View style={styles.titleBlock}>
        <Text style={styles.title} numberOfLines={1}>
          Source Control
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {worktreeLabel}
        </Text>
      </View>
      {onOpenPrWeb ? (
        <Pressable
          style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshButtonPressed]}
          onPress={onOpenPrWeb}
          hitSlop={8}
          accessibilityRole="link"
          accessibilityLabel={
            prNumber != null
              ? `Open pull request #${prNumber} on the web`
              : 'Open pull request on the web'
          }
        >
          <ExternalLink size={18} color={colors.textSecondary} strokeWidth={2.1} />
        </Pressable>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.refreshButton,
          ioBusy && styles.refreshButtonDisabled,
          pressed && styles.refreshButtonPressed
        ]}
        onPress={onRefresh}
        disabled={ioBusy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Refresh source control"
      >
        <RefreshCw size={18} color={colors.textSecondary} strokeWidth={2.1} />
      </Pressable>
    </View>
  )
}
