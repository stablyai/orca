import { ScreenHeader } from '../../components/nav-bar/ScreenHeader'
import { isMenuAction } from '../../components/nav-bar/screen-header-props'
import type { HomeTabHeaderProps } from './home-tab-header-props'

/** A Home tab's native header: a large title, its buttons in the bar's toolbar. */
export function MobileHomeTabHeader(props: HomeTabHeaderProps) {
  return (
    <ScreenHeader
      title={props.title}
      largeTitle
      // The bar can't spin a glyph, so a refresh in flight disables its button instead.
      actions={props.actions.map((action) =>
        !isMenuAction(action) && action.spinning ? { ...action, disabled: true } : action
      )}
    />
  )
}
