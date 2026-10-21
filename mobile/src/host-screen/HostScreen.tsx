import { HostScreenView } from './host-screen-view'
import { type HostScreenProps, useHostScreenController } from './use-host-screen-controller'

/**
 * The worktree list, and the one screen that renders both natively and inside the shell's page.
 *
 * In its own module rather than in the route file because two places mount it: the wide-layout
 * sidebar and the page's route file, which cannot import the native route file — that one reaches
 * the native shell view, whose module calls `requireNativeViewManager` at import and throws in a
 * browser.
 */
export function HostScreen(props: HostScreenProps = {}) {
  const controller = useHostScreenController(props)
  return <HostScreenView controller={controller} />
}
