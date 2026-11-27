import type { WebContents } from 'electron'

export type MainRendererSender = Pick<WebContents, 'id' | 'isDestroyed' | 'getType' | 'getURL'>

export function isTrustedMainRendererSender(
  sender: MainRendererSender,
  pinnedWebContentsId: number | null
): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (pinnedWebContentsId != null) {
    return sender.id === pinnedWebContentsId
  }

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!rendererUrl) {
    // Packaged builds trust only the registered main-window ID, never arbitrary file:// documents.
    return false
  }
  try {
    return new URL(sender.getURL()).origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
}
