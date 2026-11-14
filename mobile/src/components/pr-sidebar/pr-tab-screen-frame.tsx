import type { ReactNode } from 'react'
import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { NavBar } from '../nav-bar/NavBar'
import { NavBarButton } from '../nav-bar/NavBarButton'
import { MobileLoadErrorState, MobileStateView } from '../MobileStateView'
import type { MobilePrTab } from './use-mobile-pr-tab'

export type ScreenProps = {
  tab: MobilePrTab
  onBack: () => void
  bottomInset?: number
  /** Opens a PR file in the app's diff; without it, file links fall back to GitHub. */
  onOpenFile?: (filePath: string) => void
}

export function ScreenFrame({
  title,
  subtitle,
  onBack,
  backLabel,
  trailing,
  children,
  footer
}: {
  title: string
  subtitle?: string
  onBack: () => void
  backLabel?: string
  trailing?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.screen}>
      <SafeAreaView edges={['top']}>
        <NavBar
          leading={
            <NavBarButton
              icon={ChevronLeft}
              onPress={onBack}
              accessibilityLabel={
                backLabel ?? t('pullRequest.screens.back', 'Back to pull request')
              }
            />
          }
          title={title}
          subtitle={subtitle}
          trailing={trailing}
        />
      </SafeAreaView>
      {children}
      {footer}
    </View>
  )
}

// A pushed screen outlives the read that opened it: show a failed refresh, not an endless spinner.
export function NotReady({ tab }: { tab: MobilePrTab }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { state } = tab
  if (state.kind === 'error' || state.kind === 'blocked') {
    return (
      <MobileLoadErrorState
        error={state.message}
        onRetry={() => tab.refetch({ includeDetails: true })}
      />
    )
  }
  if (state.kind === 'none') {
    return (
      <MobileStateView
        title={t('pullRequest.screens.noPullRequest', 'This branch has no pull request now.')}
      />
    )
  }
  return (
    <MobileStateView loading title={t('components.prSidebar.loading', 'Loading pull request…')} />
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase }
}))
