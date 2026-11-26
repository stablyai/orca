import {
  BROWSER_GUEST_PROTECTION_CHALLENGE,
  BROWSER_GUEST_PROTECTION_REPORT
} from '../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

/** Private preload state: page code cannot report itself clean or read the challenge. */
export function installBrowserGuestEditProtection(port: {
  send: (channel: string, payload: unknown) => void
  on: (channel: string, listener: (payload: unknown) => void) => void
}): void {
  let dirty = false
  let generation: string | null = null
  let lastReported: string | undefined
  const report = (snapshot = false): void => {
    if (!generation) {
      return
    }
    const payload = {
      generation,
      dirty,
      pictureInPicture: isPictureInPicture(),
      contentType: document.contentType
    }
    const key = `${dirty} ${payload.pictureInPicture} ${payload.contentType}`
    if (snapshot || key !== lastReported) {
      lastReported = key
      port.send(BROWSER_GUEST_PROTECTION_REPORT, payload)
    }
  }
  const edited = (): void => {
    dirty = true
    report()
  }
  // Capture before page handlers; reset, submit and SPA steps do not retire the document's edits.
  window.addEventListener('input', edited, true)
  window.addEventListener('change', edited, true)
  // Video picture-in-picture events bubble from the element; a document picture-in-picture
  // window reports its own close.
  const pictureInPictureChanged = (): void => report()
  window.addEventListener('enterpictureinpicture', pictureInPictureChanged, true)
  window.addEventListener('leavepictureinpicture', pictureInPictureChanged, true)
  const documentPictureInPicture =
    'documentPictureInPicture' in window ? window.documentPictureInPicture : undefined
  if (documentPictureInPicture instanceof EventTarget) {
    documentPictureInPicture.addEventListener('enter', () => {
      report()
      const pictureInPictureWindow =
        'window' in documentPictureInPicture ? documentPictureInPicture.window : undefined
      if (pictureInPictureWindow instanceof EventTarget) {
        pictureInPictureWindow.addEventListener('pagehide', pictureInPictureChanged)
      }
    })
  }
  port.on(BROWSER_GUEST_PROTECTION_CHALLENGE, (payload) => {
    if (typeof payload !== 'string') {
      return
    }
    generation = payload
    report(true)
  })
  window.addEventListener('pageshow', (event) => {
    if (event.isTrusted) {
      port.send(BROWSER_GUEST_PROTECTION_REPORT, { ready: true })
    }
  })
  port.send(BROWSER_GUEST_PROTECTION_REPORT, { ready: true })
}

function isPictureInPicture(): boolean {
  if (document.pictureInPictureElement) {
    return true
  }
  const documentPictureInPicture =
    'documentPictureInPicture' in window ? window.documentPictureInPicture : undefined
  return Boolean(
    documentPictureInPicture &&
    typeof documentPictureInPicture === 'object' &&
    'window' in documentPictureInPicture &&
    documentPictureInPicture.window
  )
}
