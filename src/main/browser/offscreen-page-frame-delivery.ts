import { sharedTexture } from 'electron'
import type { OffscreenSharedTexture, WebContents } from 'electron'

/**
 * Hands one GPU frame to the renderer showing the page, tagged with the page id its receiver keys
 * canvases by. The texture returns to Chromium's pool once the renderer releases its import.
 */
export async function sendOffscreenPageFrame(
  renderer: WebContents | null,
  texture: OffscreenSharedTexture,
  browserPageId: string
): Promise<void> {
  if (!renderer) {
    texture.release()
    return
  }
  const imported = sharedTexture.importSharedTexture({
    textureInfo: texture.textureInfo,
    allReferencesReleased: () => texture.release()
  })
  try {
    await sharedTexture.sendSharedTexture(
      { frame: renderer.mainFrame, importedSharedTexture: imported },
      browserPageId
    )
  } finally {
    imported.release()
  }
}
