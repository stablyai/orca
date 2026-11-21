import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { assertTrustedClipboardSender } from '../clipboard/clipboard-ipc-sender-trust'
import {
  pluginPanelCaptureRect,
  withPaintingWhileHidden
} from '../../plugins/view/plugin-view-capture'

/** The largest frame rect accepted, in CSS pixels: far beyond any window, so only junk is refused. */
export const NATIVE_CHAT_FRAME_CAPTURE_MAX_EDGE = 16_384

/** A frame is drawn into a marked image of at most this long edge, so larger captures are scaled
 *  down here: smaller PNGs to encode, send and keep. Matches the renderer's marked-image cap. */
export const NATIVE_CHAT_FRAME_CAPTURE_OUTPUT_EDGE = 2048

export type NativeChatFrameCaptureRect = { x: number; y: number; width: number; height: number }

const FrameRect = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().min(1).max(NATIVE_CHAT_FRAME_CAPTURE_MAX_EDGE),
  height: z.number().finite().min(1).max(NATIVE_CHAT_FRAME_CAPTURE_MAX_EDGE)
})

/** The frame rect the renderer measured, checked: finite, inside the window's origin, with area. */
export function nativeChatFrameCaptureRect(rect: unknown): NativeChatFrameCaptureRect {
  const parsed = FrameRect.safeParse(rect)
  if (!parsed.success) {
    throw new Error('Invalid frame rect')
  }
  return parsed.data
}

/** The pixels on screen inside `rect` (CSS pixels of the sender's page) as PNG bytes, at the display's
 *  own resolution. Why a screen capture: a video served by the media scheme taints a canvas, so the
 *  renderer can't read its frame itself. */
export async function captureNativeChatFrame(
  contents: WebContents,
  rect: NativeChatFrameCaptureRect
): Promise<Uint8Array> {
  const target = pluginPanelCaptureRect(rect, contents.getZoomFactor())
  const image = await withPaintingWhileHidden([contents], () =>
    contents.capturePage(target, { stayHidden: true })
  )
  if (image.isEmpty()) {
    throw new Error('Nothing was drawn to capture')
  }
  const { width, height } = image.getSize()
  const scale = NATIVE_CHAT_FRAME_CAPTURE_OUTPUT_EDGE / Math.max(width, height)
  const output =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'best'
        })
      : image
  return new Uint8Array(output.toPNG())
}

export function registerNativeChatFrameCaptureHandler(): void {
  ipcMain.removeHandler('nativeChat:captureFrame')
  ipcMain.handle(
    'nativeChat:captureFrame',
    async (event: IpcMainInvokeEvent, rect: unknown): Promise<Uint8Array> => {
      // The main window's renderer only, as for generated images.
      assertTrustedClipboardSender(event)
      return captureNativeChatFrame(event.sender, nativeChatFrameCaptureRect(rect))
    }
  )
}
