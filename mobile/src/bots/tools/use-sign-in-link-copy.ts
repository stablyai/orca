// A sign-in page this phone's shell can't open (a link longer than it takes) is copied for the browser
// instead, keeping the same attempt; a newer shell opens it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { canOpenExternalLink } from '../../platform/external-links/external-link'

export type SignInLinkCopy = {
  /** False when this phone's shell can't open the page: copy it instead. */
  opensHere: boolean
  copyLink: () => void
  /** The page's link is on the clipboard. */
  copied: boolean
  /** The last copy of this link failed. */
  copyFailed: boolean
}

export function useSignInLinkCopy(url: string | null): SignInLinkCopy {
  const opensHere = useMemo(() => url === null || canOpenExternalLink(url), [url])
  const clipboard = useClipboardWriter()
  // The last copy's link and outcome; both go with their attempt.
  const [copy, setCopy] = useState<{ url: string; copied: boolean } | null>(null)
  if (copy !== null && copy.url !== url) {
    setCopy(null)
  }
  // A copy that settles after its attempt ended reports nothing.
  const latest = useRef(url)
  useEffect(() => {
    latest.current = url
  }, [url])
  const copyLink = useCallback(() => {
    if (!url) {
      return
    }
    const settled = (copied: boolean) => {
      if (latest.current === url) {
        setCopy({ url, copied })
      }
    }
    void clipboard.writeText(url).then(
      () => settled(true),
      () => settled(false)
    )
  }, [clipboard, url])
  const shown = copy !== null && copy.url === url ? copy : null
  return {
    opensHere,
    copyLink,
    copied: shown?.copied === true,
    copyFailed: shown?.copied === false
  }
}
