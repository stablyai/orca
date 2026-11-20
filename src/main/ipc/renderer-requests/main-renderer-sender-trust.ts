import type { WebContents } from 'electron'

export function isTrustedMainRendererSender(
  sender: WebContents,
  pinnedWebContentsId: number | null
): boolean {
  if (pinnedWebContentsId != null) {
    // The pinned ID belongs to the main window's contents, so getType() adds nothing here.
    return sender.id === pinnedWebContentsId && !sender.isDestroyed()
  }
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
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
