// A sign-in page this phone's shell can't open (a link longer than it takes) is copied for the browser
// instead, keeping the same attempt; a newer shell opens it.
import { useCallback, useMemo, useState } from 'react'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { canOpenExternalLink } from '../../platform/external-links/external-link'

export type SignInLinkCopy = {
  /** False when this phone's shell can't open the page: copy it instead. */
  opensHere: boolean
  copyLink: () => void
  /** The page's link is on the clipboard. */
  copied: boolean
}

export function useSignInLinkCopy(
  url: string | null,
  /** Each copy's outcome, for the page's error line. */
  onCopy: (copied: boolean) => void
): SignInLinkCopy {
  const opensHere = useMemo(() => url === null || canOpenExternalLink(url), [url])
  const clipboard = useClipboardWriter()
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  // The copied link goes with its attempt, including one a late copy reported after it ended.
  if (copiedUrl !== null && copiedUrl !== url) {
    setCopiedUrl(null)
  }
  const copyLink = useCallback(() => {
    if (url) {
      void clipboard.writeText(url).then(
        () => {
          setCopiedUrl(url)
          onCopy(true)
        },
        () => onCopy(false)
      )
    }
  }, [clipboard, url, onCopy])
  return { opensHere, copyLink, copied: url !== null && copiedUrl === url }
}
