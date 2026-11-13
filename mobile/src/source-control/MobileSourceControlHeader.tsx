import { useRef, useState, type ReactNode } from 'react'
import type { HostInstance } from 'react-native'
import { ChevronLeft, ExternalLink, MoreHorizontal, RefreshCw, X } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { useRefreshHint } from '../query/refresh-hint'

type Props = {
  embedded: boolean
  worktreeLabel: string
  ioBusy: boolean
  /** Shown rows are being re-read; the line waits out quick reads. */
  refreshing: boolean
  onBack: () => void
  /** Back to the screen this hub was opened over in place, e.g. a folder's list; drawn beside dock Close. */
  backInPlace?: { onPress: () => void; label: string }
  // Dock dismissal does not pop a route; keep it separate from Back.
  onClose: () => void
  onRefresh: () => void
  // Keep open-on-web in the header while the PR body scrolls.
  onOpenPrWeb?: () => void
  prNumber?: number | null
  /** The Changes / Pull Request / Commits switch, under the title like every other screen's. */
  accessory?: ReactNode
  /** The active tab's own menu, e.g. the PR tab's; replaces the default refresh/open items. */
  menuGroups?: ActionSheetAction[][] | null
}

export function MobileSourceControlHeader({
  embedded,
  worktreeLabel,
  ioBusy,
  refreshing,
  onBack,
  backInPlace,
  onClose,
  onRefresh,
  onOpenPrWeb,
  prNumber = null,
  accessory,
  menuGroups = null
}: Props) {
  const t = useMobileTranslation()
  // Here, not in the panel, so the hint's timers re-render only the bar.
  const showRefreshLine = useRefreshHint(refreshing)
  const moreRef = useRef<HostInstance>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const actions: ActionSheetAction[] = [
    {
      id: 'refresh',
      label: t('sourceControl.header.refresh', 'Refresh source control'),
      icon: RefreshCw,
      disabled: ioBusy,
      onPress: onRefresh
    },
    ...(onOpenPrWeb
      ? [
          {
            id: 'openPrWeb',
            label:
              prNumber != null
                ? t(
                    'sourceControl.header.openNumberedPrWeb',
                    'Open pull request #{{number}} on the web',
                    { number: prNumber }
                  )
                : t('sourceControl.header.openPrWeb', 'Open pull request on the web'),
            icon: ExternalLink,
            closeBeforePress: true,
            onPress: onOpenPrWeb
          }
        ]
      : [])
  ]
  const closeButton = (
    <NavBarButton
      icon={X}
      onPress={onClose}
      accessibilityLabel={t('sourceControl.header.close', 'Close source control')}
    />
  )
  return (
    <>
      <NavBar
        // Dock dismissal and route Back have distinct semantics.
        leading={
          backInPlace ? (
            <NavBarButton
              icon={ChevronLeft}
              onPress={backInPlace.onPress}
              accessibilityLabel={backInPlace.label}
            />
          ) : embedded ? (
            closeButton
          ) : (
            <NavBarButton
              icon={ChevronLeft}
              onPress={onBack}
              accessibilityLabel={t('sourceControl.header.backToSession', 'Back to session')}
            />
          )
        }
        title={t('sourceControl.header.title', 'Source Control')}
        subtitle={worktreeLabel}
        accessory={accessory}
        refreshing={showRefreshLine}
        trailing={
          <>
            {backInPlace && embedded ? closeButton : null}
            <NavBarButton
              ref={moreRef}
              icon={MoreHorizontal}
              onPress={() => setMenuOpen(true)}
              active={menuOpen}
              accessibilityLabel={t(
                'sourceControl.header.moreActions',
                'More source control actions'
              )}
            />
          </>
        }
      />
      <PullDownMenu
        visible={menuOpen}
        anchorRef={moreRef}
        groups={menuGroups ?? [actions]}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}
