import { ChevronLeft, MoreHorizontal } from '../../../components/icons/app-icons'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { ActionSheetAction } from '../../../components/sheets/ActionSheetModal'
import { NavBar, NavBarTitleButton } from '../../../components/nav-bar/NavBar'
import { NavBarButton } from '../../../components/nav-bar/NavBarButton'
import { NativeMenu } from '../../../components/menu/NativeMenu'

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
  return (
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
        <NativeMenu groups={[actions]}>
          {(openMenu) => (
            <NavBarButton
              icon={MoreHorizontal}
              onPress={openMenu}
              accessibilityLabel={t(
                'components.diffReviewHeader.openReviewActions',
                'Open review actions'
              )}
            />
          )}
        </NativeMenu>
      }
    />
  )
}
