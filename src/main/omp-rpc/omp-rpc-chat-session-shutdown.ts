// App-quit teardown for every RPC-owned chat session a registry holds. Its own
// module because omp-rpc-chat-session-registry.ts is at its line budget.

import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { OmpRpcChatSession } from './omp-rpc-chat-session'
import type { OmpRpcLocalSessionWriteFence } from './omp-rpc-local-session-write-fence'

type WriterFence = { path: string; owner: string }

export async function disposeOmpRpcChatSessionRegistry(args: {
  sessions: Map<string, OmpRpcChatSession>
  ptyOwnerRegistry: ClaimedAgentPtyOwnerRegistry
  pendingAcquires: Iterable<Promise<unknown>>
  pendingUnregisteredChildExits: Iterable<Promise<void>>
  claims: Map<string, unknown>
  sessionFilePaths: Map<string, string>
  sessionIds: Map<string, string>
  handbackOwedPaneKeys: Set<string>
  generations: Map<string, number>
  writerFences: Map<string, WriterFence>
  writerFence: OmpRpcLocalSessionWriteFence
}): Promise<void> {
  const writerFences = [...args.writerFences.entries()]
  args.claims.clear()
  args.sessionFilePaths.clear()
  args.sessionIds.clear()
  args.handbackOwedPaneKeys.clear()
  args.generations.clear()
  await disposeAllOmpRpcChatSessions(
    args.sessions,
    args.ptyOwnerRegistry,
    args.pendingAcquires,
    args.pendingUnregisteredChildExits
  )
  for (const [paneKey, writerFence] of writerFences) {
    args.writerFence.release(writerFence.path, writerFence.owner)
    if (args.writerFences.get(paneKey)?.owner === writerFence.owner) {
      args.writerFences.delete(paneKey)
    }
  }
}

/** SIGTERMs each child, frees each claim, drops the registrations, and resolves
 *  only once every child has ACTUALLY exited (XLR-R6-005, cross-lab review).
 *  The returned promise is what the caller joins into the application's
 *  teardown barrier: a SIGTERM the child delays or ignores is not disposal, the
 *  transport's SIGKILL escalation rides an unref'd timer, and `app.quit()`
 *  reached before either left an `omp --mode rpc` child still writing the
 *  session for a relaunched Orca to collide with. */
export function disposeAllOmpRpcChatSessions(
  sessions: Map<string, OmpRpcChatSession>,
  ptyOwnerRegistry: ClaimedAgentPtyOwnerRegistry,
  pendingAcquires: Iterable<Promise<unknown>> = [],
  pendingUnregisteredChildExits: Iterable<Promise<void>> = []
): Promise<void> {
  const exits = [...sessions.values()].map((session) =>
    session.forceDisposeForShutdown(ptyOwnerRegistry)
  )
  sessions.clear()
  return Promise.allSettled([...exits, ...pendingAcquires])
    .then(() => Promise.allSettled(pendingUnregisteredChildExits))
    .then(() => undefined)
}
