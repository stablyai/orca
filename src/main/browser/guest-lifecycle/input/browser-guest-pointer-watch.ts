import type { WebContents } from 'electron'
import type { BrowserScreencastPointer } from '../../../../shared/browser/runtime/runtime-browser-contracts'

/** Follows the guest's cursor and hovered link, which viewers need since they draw only frames. */
export function watchGuestPointer(
  guest: WebContents,
  onChange: (pointer: BrowserScreencastPointer) => void
): { current: () => BrowserScreencastPointer; stop: () => void } {
  // `pointer` is Electron's name for the arrow.
  let pointer: BrowserScreencastPointer = { cursor: 'pointer', targetUrl: '' }
  const update = (next: Partial<BrowserScreencastPointer>): void => {
    const merged = { ...pointer, ...next }
    if (merged.cursor === pointer.cursor && merged.targetUrl === pointer.targetUrl) {
      return
    }
    pointer = merged
    onChange(pointer)
  }
  const handleCursor = (_event: Electron.Event, type: string): void => update({ cursor: type })
  const handleTargetUrl = (_event: Electron.Event, url: string): void => update({ targetUrl: url })
  // A guest that dies under a hovered link never reports leaving it.
  const handleGone = (): void => update({ cursor: 'pointer', targetUrl: '' })
  guest.on('cursor-changed', handleCursor)
  guest.on('update-target-url', handleTargetUrl)
  guest.on('render-process-gone', handleGone)
  return {
    current: () => pointer,
    stop: () => {
      if (guest.isDestroyed()) {
        return
      }
      guest.off('cursor-changed', handleCursor)
      guest.off('update-target-url', handleTargetUrl)
      guest.off('render-process-gone', handleGone)
    }
  }
}
