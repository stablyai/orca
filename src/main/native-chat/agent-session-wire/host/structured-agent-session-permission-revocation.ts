import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

type Adapter = Pick<StructuredAgentSessionAdapter, 'setPermissionDispatchRevoked'>
type Release = () => void

/** At an admitted cut of this exact child: its queued permission-mode writes never reach it.
 *  The release undoes only this cut, and only while the same child is live and not closing (its
 *  end failed or never began); other cuts of the child still hold. */
export function cutChildPermissionWrites(
  adapter: Adapter,
  sessionId: string,
  session: Pick<StructuredAgentSessionHostSession, 'child'> | undefined
): Release {
  const child = session?.child
  const generation = child?.generation
  if (!child || !generation) {
    return () => {}
  }
  adapter.setPermissionDispatchRevoked?.(sessionId, child.fence, generation, true)
  let held = true
  return () => {
    if (held && session.child === child && !child.close) {
      held = false
      adapter.setPermissionDispatchRevoked?.(sessionId, child.fence, generation, false)
    }
  }
}

/** Runs an end whose cuts are released when it settles: after a real end the child is gone or
 *  closing and nothing is released; after a failed one the live child keeps its writes. */
export async function releasingCuts<T>(
  first: Release | undefined,
  run: (own: (release: Release | false | undefined) => void) => Promise<T>
): Promise<T> {
  const releases = first ? [first] : []
  try {
    return await run((release) => {
      if (release) {
        releases.push(release)
      }
    })
  } finally {
    releases.forEach((release) => release())
  }
}
