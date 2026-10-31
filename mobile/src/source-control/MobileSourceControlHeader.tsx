import { useRef, useState } from 'react'
import type { View } from 'react-native'
import { ChevronLeft, ExternalLink, MoreHorizontal, RefreshCw, X } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'

type Props = {
  embedded: boolean
  worktreeLabel: string
  ioBusy: boolean
  onBack: () => void
  // Dock dismissal does not pop a route; keep it separate from Back.
  onClose: () => void
  onRefresh: () => void
  // Keep open-on-web in the header while the PR body scrolls.
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
  const t = useMobileTranslation()
  const moreRef = useRef<View>(null)
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
  return (
    <>
      <NavBar
        // Dock dismissal and route Back have distinct semantics.
        leading={
          embedded ? (
            <NavBarButton
              icon={X}
              onPress={onClose}
              accessibilityLabel={t('sourceControl.header.close', 'Close source control')}
            />
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
        trailing={
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
        }
      />
      <PullDownMenu
        visible={menuOpen}
        anchorRef={moreRef}
        groups={[actions]}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}
