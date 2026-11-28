import { ChevronLeft } from 'lucide-react-native'
import { View, useWindowDimensions } from 'react-native'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { duoRailBackFrame } from '../layout/duo-status-row'
import { useReservedRegions } from '../layout/reserved-regions'
import { getSideRailStrip } from '../layout/side-rail-strip'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import { duoRailBackVisible } from './duo-rail-back'
import { useDuoChatExpanded } from './duo-chat-width'

/** Back sits below the status occlusion, on the cluster's midX, and hides while the keyboard is up. */

export function DuoRailBackButton({
  chatVisible,
  keyboardInset,
  onBack
}: {
  chatVisible: boolean
  keyboardInset: number
  onBack: () => void
}) {
  const t = useMobileTranslation()
  const expanded = useDuoChatExpanded()
  const { width, height } = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  const { occlusions } = useReservedRegions()
  const strip = getSideRailStrip({
    windowWidth: width,
    windowHeight: height,
    insets,
    occlusions
  })
  if (!duoRailBackVisible({ chatVisible, expanded, strip, keyboardInset }) || strip === null) {
    return null
  }
  const frame = duoRailBackFrame({
    windowWidth: width,
    windowHeight: height,
    strip,
    occlusions
  })
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: frame.top,
        left: frame.left,
        width: frame.size,
        height: frame.size
      }}
    >
      <NavBarButton
        accessibilityLabel={t('session.header.backToWorktrees', 'Back to worktrees')}
        icon={ChevronLeft}
        onPress={onBack}
        size={frame.size}
      />
    </View>
  )
}
