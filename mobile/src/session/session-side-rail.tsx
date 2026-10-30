import { Pressable, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useSideRailClaim, useSideRailEdge } from '../layout/side-rail'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileSessionAccessoryKeys } from './MobileSessionAccessoryKeys'
import { sessionCommandDockShown } from './MobileSessionCommandDock'
import type { MobileSessionController } from './use-mobile-session-controller'

export type SessionRailPlacement = { backInRail: boolean; keysInRail: boolean }

// The Duo's side rail takes what would cost the session rows: the terminal keys, and Back on the cover, where no sidebar sits beside it.
export function useSessionSideRail(controller: MobileSessionController): SessionRailPlacement {
  const edge = useSideRailEdge()
  const { isWideLayout } = useResponsiveLayout()
  const backInRail = edge !== null && !isWideLayout
  const keysInRail = edge !== null && sessionCommandDockShown(controller)
  useSideRailClaim(
    backInRail || keysInRail ? (
      <SessionRail controller={controller} back={backInRail} keys={keysInRail} />
    ) : null
  )
  return { backInRail, keysInRail }
}

function SessionRail({
  controller,
  back,
  keys
}: {
  controller: MobileSessionController
  back: boolean
  keys: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={[styles.rail, { paddingBottom: controller.keyboardLift }]}>
      {back ? (
        <Pressable
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
          onPress={controller.requestLeaveSession}
          accessibilityRole="button"
          accessibilityLabel={t('session.sideRail.backToWorktrees', 'Back to worktrees')}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
      ) : null}
      {keys ? <MobileSessionAccessoryKeys controller={controller} vertical /> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  rail: {
    flex: 1,
    alignItems: 'stretch',
    gap: spacing.md
  },
  back: {
    alignSelf: 'center',
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  backPressed: {
    backgroundColor: colors.borderSubtle
  }
}))
