import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { WorkInboxStore, type WorkInboxAsker } from './work-inbox-store'
import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import { readStructuredAgentSessionRecord } from '../structured-worker-authority'

const stores = new WeakMap<OrchestrationDb, WorkInboxStore>()
const waiters = new Map<string, Set<() => void>>()

/** Re-read cadence for a blocked ask; the durable row is the truth, a wake only shortens the wait. */
export const WORK_INBOX_ASK_POLL_MS = 5_000

export function workInboxStoreFor(db: OrchestrationDb): WorkInboxStore {
  let store = stores.get(db)
  if (!store) {
    store = new WorkInboxStore(db.db)
    stores.set(db, store)
  }
  return store
}

export function wakeWorkInboxWaiters(id: string): boolean {
  const active = waiters.get(id)
  const waiting = Boolean(active?.size)
  for (const wake of active ?? []) {
    wake()
  }
  return waiting
}

export function waitForWorkInboxChange(
  id: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set<() => void>()
    waiters.set(id, set)
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      set.delete(done)
      if (set.size === 0) {
        waiters.delete(id)
      }
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, timeoutMs))
    set.add(done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Project and agent come from the asking terminal; any unresolved part stays null. */
export function resolveWorkInboxAsker(runtime: OrcaRuntimeService, handle: string): WorkInboxAsker {
  const paneKey = runtime.getTerminalPaneKey(handle)
  const sessionId = parseOrcaSessionAddress(handle)
  const session = sessionId ? readStructuredAgentSessionRecord(sessionId) : null
  const worktreeId = session?.location.workspaceId ?? runtime.getTerminalWorktreeIdForHandle(handle)
  const repoId = worktreeId ? getRepoIdFromWorktreeId(worktreeId) : null
  const repo = repoId ? runtime.listRepos().find((candidate) => candidate.id === repoId) : undefined
  const agentKind = paneKey
    ? (runtime.getAgentStatusRowsForPane(paneKey).find((row) => row.agentType)?.agentType ?? null)
    : null
  return {
    handle,
    paneKey,
    projectId: repoId,
    projectLabel: repo?.displayName ?? null,
    worktreeId,
    agentKind: session?.provider ?? agentKind
  }
}
