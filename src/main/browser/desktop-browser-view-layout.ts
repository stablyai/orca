import type { DesktopBrowserViewLayout } from '../../shared/desktop-browser-view-protocol'

export function getDesktopBrowserViewLayout(
  layout: DesktopBrowserViewLayout,
  owner: Pick<Electron.Rectangle, 'width' | 'height'>,
  scale: number
): { container: Electron.Rectangle; content: Electron.Rectangle; visible: boolean } {
  const scaled = (bounds: Electron.Rectangle): Electron.Rectangle => ({
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale))
  })
  const page = scaled(layout.bounds)
  const clip = layout.clipBounds ? scaled(layout.clipBounds) : page
  const left = Math.max(0, clip.x, page.x)
  const top = Math.max(0, clip.y, page.y)
  const right = Math.min(owner.width, clip.x + clip.width, page.x + page.width)
  const bottom = Math.min(owner.height, clip.y + clip.height, page.y + page.height)
  const visible = layout.visible && !layout.inputLocked && right > left && bottom > top
  return {
    container: {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    },
    content: { x: page.x - left, y: page.y - top, width: page.width, height: page.height },
    visible
  }
}
