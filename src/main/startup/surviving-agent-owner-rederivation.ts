import type { SessionInfo } from '../daemon/types'
import type { AgentHookServer } from '../agent-hooks/server'
import type {
  AgentPresenceCaptureOptions,
  AgentProcessPresence
} from '../../shared/agent-process-presence'
import { forEachWithConcurrency } from '../../shared/map-with-concurrency'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { indexPersistedPtySurfaceBindings } from '../runtime/runtime-worktree-binding-index'

/** A few captures at a time, so a busy boot neither forks per pane nor stalls behind one. */
export const SURVIVING_OWNER_CAPTURE_CONCURRENCY = 4

/**
 * Owners live only in memory: once the daemon lists its surviving sessions, each one still bound to
 * a saved pane re-derives its owner, a few at a time. Every read shares one process table, and
 * nothing else changes: no terminal records, liveness verdicts, handle adoption or foreground refresh.
 */
export async function rederiveSurvivingAgentOwners(deps: {
  listSessions: () => Promise<SessionInfo[] | null>
  readWorkspaceSession: () => WorkspaceSessionState | null | undefined
  capture: (
    id: string,
    options: AgentPresenceCaptureOptions
  ) => Promise<AgentProcessPresence | undefined> | undefined
  admit: AgentHookServer['ingestForegroundPresence']
}): Promise<void> {
  const sessions = (await deps.listSessions().catch(() => null)) ?? []
  const surfaces = indexPersistedPtySurfaceBindings(deps.readWorkspaceSession())
  const evidenceAtMs = Date.now()
  await forEachWithConcurrency(
    sessions,
    SURVIVING_OWNER_CAPTURE_CONCURRENCY,
    async (session) => {
      const surface = surfaces.get(session.sessionId)
      // Why: a WSL guest has no host-checkable owner; a different incarnation is another terminal.
      if (!surface || !session.isAlive || session.wslDistro || !session.incarnationId) {
        return
      }
      if (surface.incarnationId !== session.incarnationId) {
        return
      }
      const presence = await Promise.resolve(
        deps.capture(session.sessionId, { snapshotNotBeforeMs: evidenceAtMs })
      ).catch(() => undefined)
      if (presence) {
        // Why: one failed admit must not end its worker and skip the sessions queued behind it.
        await deps
          .admit(
            {
              paneKey: surface.paneKey,
              connectionId: null,
              worktreeId: surface.worktreeId,
              tabId: surface.tabId
            },
            presence
          )
          .catch((error: unknown) => {
            console.warn('[agent-presence] surviving owner admit failed:', error)
          })
      }
    }
  )
}
