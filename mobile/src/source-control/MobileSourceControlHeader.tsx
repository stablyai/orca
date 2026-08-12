import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, ExternalLink, RefreshCw, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-source-control-styles'

type Props = {
  embedded: boolean
  worktreeLabel: string
  ioBusy: boolean
  onBack: () => void
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
  onRefresh,
  onOpenPrWeb,
  prNumber = null
}: Props) {
  return (
    <View style={styles.topBar}>
      <Pressable
        style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
        onPress={onBack}
        hitSlop={8}
        accessibilityLabel={embedded ? 'Close source control' : 'Back to session'}
      >
        {embedded ? (
          <X size={22} color={colors.textSecondary} strokeWidth={2.2} />
        ) : (
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        )}
      </Pressable>
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
        accessibilityLabel="Refresh source control"
      >
        <RefreshCw size={18} color={colors.textSecondary} strokeWidth={2.1} />
      </Pressable>
    </View>
  )
}
