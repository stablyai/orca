import { View } from 'react-native'
import { ExternalLink, MoreHorizontal, RefreshCw, X } from 'lucide-react-native'
import { IconButton } from '../components/ui/IconButton'
import { NavBar } from '../components/ui/NavBar'
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
  // When set (PR segment ready with a host URL), show open-on-web in the bar so the
  // control stays visible while the PR body scrolls.
  onOpenPrWeb?: () => void
  prNumber?: number | null
  /** Opens the source control action sheet; the bar's second slot when open-on-web is absent. */
  onOpenActions?: () => void
}

export function MobileSourceControlHeader({
  embedded,
  worktreeLabel,
  ioBusy,
  onBack,
  onClose,
  onRefresh,
  onOpenPrWeb,
  prNumber = null,
  onOpenActions
}: Props) {
  return (
    <View>
      <NavBar
        title="Source control"
        subtitle={worktreeLabel}
        onBack={embedded ? undefined : onBack}
        backAccessibilityLabel="Back to session"
        trailing={
          <>
            {onOpenPrWeb ? (
              <IconButton
                icon={ExternalLink}
                variant="bare"
                iconSize={20}
                onPress={onOpenPrWeb}
                accessibilityLabel={
                  prNumber != null
                    ? `Open pull request #${prNumber} on the web`
                    : 'Open pull request on the web'
                }
              />
            ) : onOpenActions ? (
              <IconButton
                icon={MoreHorizontal}
                variant="bare"
                iconSize={20}
                onPress={onOpenActions}
                disabled={ioBusy}
                accessibilityLabel="Open source control actions"
              />
            ) : null}
            <IconButton
              icon={RefreshCw}
              variant="bare"
              iconSize={19}
              onPress={onRefresh}
              disabled={ioBusy}
              accessibilityLabel="Refresh source control"
            />
          </>
        }
      />
      {/* The dock's dismiss is a close, not a back, so it gets its own glyph and name. */}
      {embedded ? (
        <View style={styles.embeddedClose}>
          <IconButton
            icon={X}
            iconSize={20}
            onPress={onClose}
            accessibilityLabel="Close source control"
          />
        </View>
      ) : null}
    </View>
  )
}
