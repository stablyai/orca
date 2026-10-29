import { useEffect, useRef } from 'react'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'
import type { BackClaim } from './use-back-claim'

// Claim shell Back on empty/nonempty stack edges; RN Web cannot intercept it. Older shells keep native pop behavior.
export function useBackClaim(claim: BackClaim): void {
  // Hold handler/client refs to avoid churn; one client lives for the document, and null outside its provider means nothing to claim.
  const client = usePageBridgeClientIfPresent()
  const latest = useRef({ claim, client })
  // Refresh refs after commit before registration so discarded renders cannot change active behavior.
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
