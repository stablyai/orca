import { MobileSessionSurface } from './MobileSessionSurface'
import { useMobileSessionController } from './use-mobile-session-controller'

/**
 * The session screen as a component rather than a route module, which is what lets a switch hold it.
 *
 * `useMobileSessionController` is 32 hooks deep and opens the terminal, chat and tab subscriptions;
 * hooks cannot be conditional, so a route file that both read the flag and called it would run all
 * of that behind the page as well as in front of it. As an element passed for `fallback` it is
 * created and not mounted, which is `MobileDiffReviewRouteScreen`'s reason and the explorer
 * switch's before it.
 *
 * The params are read below this file — the controller's own foundation hook reads them, as does
 * the notification pane hook — so nothing is handed down and the two route files above are the
 * switch and its web sibling.
 */
export function MobileSessionRouteScreen() {
  const controller = useMobileSessionController()
  return <MobileSessionSurface controller={controller} />
}
