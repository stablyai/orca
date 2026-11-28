import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'

type Adapter = Pick<StructuredAgentSessionAdapter, 'setPermissionDispatchRevoked'>

/** At an admitted cut of this exact child: its queued permission-mode writes never reach it. */
export function cutChildPermissionWrites(
  adapter: Adapter,
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity | null | undefined
): void {
  if (child?.generation) {
    adapter.setPermissionDispatchRevoked?.(sessionId, child.fence, child.generation, true)
  }
}

/** Runs an end of the child the host already cut. If it fails before the child begins closing
 *  (or, with `always`, never begins it at all), the child is still live and in use, so its
 *  permission writes are its own again. */
export async function endCutChild<T>(
  adapter: Adapter,
  sessionId: string,
  session: Pick<StructuredAgentSessionHostSession, 'child'> | undefined,
  run: () => Promise<T>,
  always = false
): Promise<T> {
  const child = session?.child
  const restore = () => {
    if (child?.generation && session?.child === child && !child.close) {
      adapter.setPermissionDispatchRevoked?.(sessionId, child.fence, child.generation, false)
    }
  }
  try {
    const ended = await run()
    if (always) {
      restore()
    }
    return ended
  } catch (error) {
    restore()
    throw error
  }
}

/** `endCutChild` run in a session's lane, on the child the lane finds. */
export function serializeCutEnd(
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>,
  adapter: () => Adapter,
  sessions: ReadonlyMap<string, Pick<StructuredAgentSessionHostSession, 'child'>>
) {
  return <T>(sessionId: string, always: boolean, end: () => Promise<T>): Promise<T> =>
    serialize(sessionId, () =>
      endCutChild(adapter(), sessionId, sessions.get(sessionId), end, always)
    )
}
