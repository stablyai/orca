import { MobileSessionSurface } from './MobileSessionSurface'
import { useMobileSessionController } from './use-mobile-session-controller'

/**
 * The session screen as a component rather than a route module: the page's route file mounts it, and
 * the native route file, which mounts the shell, cannot be imported by the page. Its params are read
 * below this file, by the controller's foundation hook and the notification pane hook.
 */
export function MobileSessionRouteScreen() {
  const controller = useMobileSessionController()
  return <MobileSessionSurface controller={controller} />
}
