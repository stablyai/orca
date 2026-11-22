import { ActivityIndicator } from 'react-native'
import { ChevronLeft, RefreshCw } from '../components/icons/app-icons'
import { NavBar, NavBarRefreshLine } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { usePageHeaderClaim } from '../platform/page-header/page-header-claim'

function RefreshingIcon({ color }: { color?: string }) {
  return <ActivityIndicator size="small" color={color} />
}

/** Accounts' top bar: the shell's native header on a granted page, the drawn bar otherwise. */
export function MobileAccountsHeader({
  hostName,
  refreshing,
  showRefreshLine,
  refreshDisabled,
  onRefresh,
  onBack
}: {
  hostName: string
  refreshing: boolean
  showRefreshLine: boolean
  refreshDisabled: boolean
  onRefresh: () => void
  onBack: () => void
}) {
  const t = useMobileTranslation()
  const title = t('accounts.screen.title', 'Accounts')
  const refreshLabel = t('accounts.screen.refreshAccounts', 'Refresh accounts')
  // The host name subtitle is the drawn bar's alone; the native bar keeps the title.
  const native = usePageHeaderClaim({
    title,
    onBack,
    actions: [
      {
        id: 'refresh',
        icon: RefreshCw,
        label: refreshLabel,
        disabled: refreshDisabled,
        onPress: onRefresh
      }
    ]
  })
  if (native) {
    return showRefreshLine ? <NavBarRefreshLine /> : null
  }
  return (
    <NavBar
      leading={
        <NavBarButton
          icon={ChevronLeft}
          onPress={onBack}
          accessibilityLabel={t('common.back', 'Back')}
        />
      }
      title={title}
      subtitle={hostName || undefined}
      refreshing={showRefreshLine}
      trailing={
        <NavBarButton
          icon={refreshing ? RefreshingIcon : RefreshCw}
          onPress={onRefresh}
          disabled={refreshDisabled}
          accessibilityLabel={refreshLabel}
        />
      }
    />
  )
}
