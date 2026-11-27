import type {
  BrowserScreencastPointer,
  BrowserScreencastResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { watchGuestPointer } from '../../../browser/guest-lifecycle/input/browser-guest-pointer-watch'
import { watchInjectedGuestContextMenus } from '../../../browser/guest-lifecycle/input/browser-guest-context-menu-target'
import type { ActiveBrowserScreencastSubscriber } from './browser-screencast-contracts'

/** The page's cursor, hovered link and right-click menus, sent to the viewers that asked for each. */
export function watchScreencastViewerPageEvents(
  guest: Electron.WebContents,
  subscribers: ReadonlyMap<string, ActiveBrowserScreencastSubscriber>
): { pointer: () => BrowserScreencastPointer; stop: () => void } {
  const send = (
    wants: (subscriber: ActiveBrowserScreencastSubscriber) => boolean,
    event: BrowserScreencastResult
  ): void => {
    for (const subscriber of subscribers.values()) {
      if (wants(subscriber)) {
        subscriber.emit?.(event)
      }
    }
  }
  const pointerWatch = watchGuestPointer(guest, (pointer) =>
    send((subscriber) => subscriber.pointerEvents, { type: 'pointer', ...pointer })
  )
  const stopContextMenus = watchInjectedGuestContextMenus(guest, (menu) =>
    send((subscriber) => subscriber.contextMenus, { type: 'contextMenu', ...menu })
  )
  return {
    pointer: pointerWatch.current,
    stop: () => {
      pointerWatch.stop()
      stopContextMenus()
    }
  }
}
