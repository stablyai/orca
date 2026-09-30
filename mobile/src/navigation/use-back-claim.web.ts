import { useEffect, useRef } from 'react'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'
import type { BackClaim } from './use-back-claim'

/**
 * Web sibling: the key belongs to the shell, so the page claims it rather than intercepting it.
 *
 * A claim is one notify, posted only when this document goes from holding nothing to holding
 * something and back; the press arrives as a `back` frame and is offered to the newest claim first.
 * A shell too old to hear the claim keeps the key and pops the screen, which is what it does today.
 */
export function useBackClaim(claim: BackClaim): void {
  // Both held rather than depended on. The handler because a caller rebuilds it every render, and
  // the client because a document holds exactly one for its lifetime: a replaced client is a
  // replaced document, and re-registering on its identity would post a frame per render instead.
  // Null outside the page's provider, which a component shared with the native app renders under:
  // there is no shell to claim from, so nothing is claimed and the key stays where it was.
  const client = usePageBridgeClientIfPresent()
  const latest = useRef({ claim, client })
  // From an effect rather than during render, which React replays and discards. Seeded by the
  // `useRef` above and declared before the registration, so that one claims against this render's
  // client. No dependency list, for the reason the values are held at all.
  useEffect(() => {
    latest.current = { claim, client }
  })
  const claimed = claim !== null && client !== null

  useEffect(() => {
    if (!claimed) {
      return
    }
    return latest.current.client?.claimBack(() => latest.current.claim?.() ?? false)
  }, [claimed])
}
