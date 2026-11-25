import { ChevronLeft } from '../icons/app-icons'
import { NativeMenu } from '../menu/NativeMenu'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { usePageHeaderClaim } from '../../platform/page-header/page-header-claim'
import { NavBar } from './NavBar'
import { NavBarButton } from './NavBarButton'
import { isMenuAction, NO_ACTIONS, type ScreenHeaderProps } from './screen-header-props'

export type { ScreenHeaderAction, ScreenHeaderProps } from './screen-header-props'

/** Web draws the bar in the page; phones get the native stack header instead. */
export const NATIVE_SCREEN_HEADER = false

/** The screen's top bar: Back, the title, and up to two buttons; in the shell, drawn natively by it. */
export function ScreenHeader({ title, onBack, actions = NO_ACTIONS }: ScreenHeaderProps) {
  const t = useMobileTranslation()
  if (usePageHeaderClaim({ title, onBack, actions })) {
    return null
  }
  return (
    <NavBar
      leading={
        onBack ? (
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('common.back', 'Back')}
            onPress={onBack}
          />
        ) : undefined
      }
      title={title}
      trailing={actions.map((action) =>
        isMenuAction(action) ? (
          <NativeMenu key={action.id} groups={action.menu} testID={action.testID}>
            {(openMenu) => (
              <NavBarButton
                icon={action.icon}
                accessibilityLabel={action.label}
                onPress={openMenu}
              />
            )}
          </NativeMenu>
        ) : (
          <NavBarButton
            key={action.id}
            icon={action.icon}
            accessibilityLabel={action.label}
            onPress={action.onPress}
            disabled={action.disabled}
          />
        )
      )}
    />
  )
}
