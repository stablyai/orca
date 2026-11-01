import { PrChecksScreen } from './PrChecksScreen'
import { PrCommentsScreen } from './PrCommentsScreen'
import type { ScreenProps } from './pr-tab-screen-frame'
import type { PrTabScreen as PrTabScreenKind } from './use-mobile-pr-tab'

// The screen a PR tab gate opens, shared by the Source Control hub and the diff-review dock.
export function PrTabScreenView({ screen, ...props }: ScreenProps & { screen: PrTabScreenKind }) {
  return screen === 'checks' ? <PrChecksScreen {...props} /> : <PrCommentsScreen {...props} />
}
