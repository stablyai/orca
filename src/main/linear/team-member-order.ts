import type { LinearMember } from '../../shared/linear/workspace-types'
import { acquire, release } from './linear-request-concurrency'
import type { LinearClientForWorkspace } from './client'

// Why: one viewer lookup per workspace credential is enough for member ordering;
// entries are replaced on credential rotation so a re-auth as another user refreshes.
const viewerIdCache = new Map<string, { revision: number; viewerId: string }>()
// Why: several dropdowns can request members at once on a cold cache; sharing
// one in-flight lookup avoids redundant viewer calls against the API limiter.
const viewerLookupInFlight = new Map<string, Promise<string | null>>()

export async function getCachedViewerId(entry: LinearClientForWorkspace): Promise<string | null> {
  const revision = entry.workspace.credentialRevision ?? 0
  const cached = viewerIdCache.get(entry.workspace.id)
  if (cached && cached.revision === revision) {
    return cached.viewerId
  }

  const inFlightKey = `${entry.workspace.id}:${revision}`
  const inFlight = viewerLookupInFlight.get(inFlightKey)
  if (inFlight) {
    return inFlight
  }

  const lookup = (async () => {
    await acquire()
    try {
      const viewer = await entry.client.viewer
      viewerIdCache.set(entry.workspace.id, { revision, viewerId: viewer.id })
      return viewer.id
    } catch (error) {
      // Member lists must not fail because the viewer lookup did.
      console.warn('[linear] viewer lookup for member ordering failed:', error)
      return null
    } finally {
      release()
      viewerLookupInFlight.delete(inFlightKey)
    }
  })()
  viewerLookupInFlight.set(inFlightKey, lookup)
  return lookup
}

// Why: host-default collators differ across macOS, Linux, and remote hosts; a
// pinned collator keeps member ordering identical everywhere Orca runs.
const memberNameCollator = new Intl.Collator('en', { sensitivity: 'variant' })

export function sortMembersViewerFirst(
  members: LinearMember[],
  viewerId: string | null
): LinearMember[] {
  return [...members].sort((a, b) => {
    if (viewerId) {
      if (a.id === viewerId) {
        return b.id === viewerId ? 0 : -1
      }
      if (b.id === viewerId) {
        return 1
      }
    }
    return (
      memberNameCollator.compare(a.displayName, b.displayName) ||
      // Ordinal id tie-break: locale-independent and stable for equal names.
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
  })
}
