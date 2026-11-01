import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentHookAuthorityEvidence } from './server-types'

/**
 * Re-points hydrated commitments of a moved pane at its new key, so closing the source tab cannot
 * revoke the live pane's evidence. Returns the same array when nothing moves.
 */
export function transferHydratedAuthorityCommitments(
  commitments: readonly AgentHookAuthorityEvidence[],
  revoked: WeakSet<AgentHookAuthorityEvidence>,
  fromPaneKey: string,
  toPaneKey: string
): readonly AgentHookAuthorityEvidence[] {
  if (!commitments.some((commitment) => commitment.paneKey === fromPaneKey)) {
    return commitments
  }
  const tabId = parsePaneKey(toPaneKey)?.tabId
  return Object.freeze(
    commitments.map((commitment) => {
      if (commitment.paneKey !== fromPaneKey) {
        return commitment
      }
      const moved = Object.freeze({
        ...commitment,
        paneKey: toPaneKey,
        ...(tabId ? { tabId } : {})
      })
      // Why: a revoked commitment must not come back to life by moving.
      if (revoked.has(commitment)) {
        revoked.add(moved)
      }
      return moved
    })
  )
}
