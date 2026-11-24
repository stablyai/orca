import { describePopupOrigin } from './popup-origin-description'

/** RenderFrameHost's last committed URL excludes pending destinations and page titles. */
export function describeCommittedPopupOrigin(contents: Electron.WebContents): {
  label: string
  insecure: boolean
} {
  try {
    const frame = contents.mainFrame
    const url = frame.url || 'about:blank'
    // Error and sandboxed documents can retain a network URL with an opaque security origin.
    if (frame.origin === 'null' && URL.canParse(url) && new URL(url).origin !== 'null') {
      return { label: 'unknown', insecure: true }
    }
    return describePopupOrigin(url)
  } catch {
    return { label: 'about:blank', insecure: false }
  }
}
