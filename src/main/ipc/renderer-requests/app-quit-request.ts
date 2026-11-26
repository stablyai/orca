import { isTrustedUIRenderer } from '../ui'
import type { MainRendererSender } from './main-renderer-sender-trust'

/** Ordinary user quit for the app window's main frame; close guards and quit vetoes may still cancel it. */
export function handleAppQuitRequest(
  event: { sender: MainRendererSender & { mainFrame: unknown }; senderFrame: unknown },
  quit: () => void
): void {
  if (isTrustedUIRenderer(event.sender) && event.senderFrame === event.sender.mainFrame) {
    quit()
  }
}
