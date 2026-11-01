import { useRef, useState } from 'react'
import type { View } from 'react-native'
import { ChevronLeft, MoreHorizontal } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { ActionSheetAction } from './ActionSheetModal'
import { NavBar, NavBarTitleButton } from './nav-bar/NavBar'
import { NavBarButton } from './nav-bar/NavBarButton'
import { PullDownMenu } from './nav-bar/PullDownMenu'

type Props = {
  /** The ⋯ menu's actions. */
  actions: ActionSheetAction[]
  /** The current file's name, or null before a file is showing. */
  fileName: string | null
  subtitle: string
  onBack: () => void
  onOpenFiles: () => void
}

export function MobileDiffReviewHeader({
  actions,
  fileName,
  subtitle,
  onBack,
  onOpenFiles
}: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const moreRef = useRef<View>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            onPress={onBack}
            accessibilityLabel={t('common.back', 'Back')}
          />
        }
        {...(fileName
          ? {
              center: (
                <NavBarTitleButton
                  title={fileName}
                  subtitle={subtitle}
                  onPress={onOpenFiles}
                  accessibilityLabel={t(
                    'components.diffReviewHeader.jumpToFile',
                    '{{fileName}}, jump to another file',
                    { fileName }
                  )}
                />
              )
            }
          : { title: t('components.diffReviewHeader.title', 'Changes') })}
        trailing={
          <NavBarButton
            ref={moreRef}
            icon={MoreHorizontal}
            onPress={() => setMenuOpen(true)}
            active={menuOpen}
            accessibilityLabel={t(
              'components.diffReviewHeader.openReviewActions',
              'Open review actions'
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
