import { nativeImage } from 'electron'
import type { DesktopBrowserViewCapture } from '../../shared/desktop-browser-view-protocol'
import type { DesktopOwnedBrowserViewRecord } from './desktop-owned-browser-view-admission'
import { getDesktopOwnedBrowserCapture } from './desktop-owned-browser-capture-registry'

export async function captureDesktopBrowserViewViewport(
  record: DesktopOwnedBrowserViewRecord
): Promise<DesktopBrowserViewCapture> {
  const capture = getDesktopOwnedBrowserCapture(record.webContents)
  if (!capture) {
    throw new Error('Desktop browser capture is unavailable')
  }
  const { data } = await capture(
    { kind: 'screenshot', params: { format: 'png', captureBeyondViewport: false } },
    () => () => {}
  )
  const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
  if (image.isEmpty()) {
    throw new Error('Desktop browser viewport capture was empty')
  }
  return { dataUrl: image.toDataURL(), ...image.getSize() }
}
