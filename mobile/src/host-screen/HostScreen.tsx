import { HostScreenView } from './host-screen-view'
import { type HostScreenProps, useHostScreenController } from './use-host-screen-controller'

// Share this module between native sidebar and page route; importing the native route reaches requireNativeViewManager and throws in browsers.
export function HostScreen(props: HostScreenProps = {}) {
  const controller = useHostScreenController(props)
  return <HostScreenView controller={controller} />
}
