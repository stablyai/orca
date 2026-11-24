import type { PluginEventName } from '../../../shared/plugins/contributions/plugin-event-contribution'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/profile-save-domains'
import type { PluginRuntimeDelegate } from '../workers/host-api/plugin-host-service-bindings'
import { readPluginWorkspaceStatuses } from '../workers/host-api/plugin-host-workspace-list'

const WORKSPACE_STATUS_DEBOUNCE_MS = 150
const WORKSPACE_STATUS_MAX_RETRIES = 2
const WORKSPACE_STATUS_RETRY_DELAY_MS = 1000
const WORKSPACE_STATUS_STATE_DOMAINS: ReadonlySet<string> = new Set([
  ...WORKTREE_METADATA_DOMAINS,
  'folderWorkspaces',
  'ui'
])

type PluginEvents = {
  emitEvent(event: PluginEventName, payload: unknown): void
  wantsEvent(event: PluginEventName): boolean
}

/**
 * `workspace.status.changed`: after agent, session, UI, or workspace state writes settle, re-read
 * workspace statuses and emit for each workspace whose status snapshot changed.
 */
export function watchPluginWorkspaceStatus(input: {
  delegate: Pick<PluginRuntimeDelegate, 'callRuntime' | 'getNotificationsMutedByWorktree'>
  events: PluginEvents
  onAgentStatus: (listener: () => void) => () => void
  onSessionWritten: (listener: () => void) => () => void
  onStateWritten: (listener: (domains: readonly string[] | undefined) => void) => () => void
  onWorktreeLifecycle?: (listener: () => void) => () => void
  delayMs?: number
  retryDelayMs?: number
}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let rerun = false
  let stopped = false
  let consecutiveFailures = 0
  const lastById = new Map<string, string>()
  const check = async (): Promise<void> => {
    timer = null
    if (stopped || inFlight) {
      return
    }
    if (!input.events.wantsEvent('workspace.status.changed')) {
      consecutiveFailures = 0
      lastById.clear()
      return
    }
    const call = input.delegate.callRuntime
    if (!call) {
      return
    }
    let shouldRetry = false
    inFlight = true
    try {
      const statuses = await readPluginWorkspaceStatuses(
        call,
        input.delegate.getNotificationsMutedByWorktree
      ).catch(() => null)
      if (stopped) {
        return
      }
      if (!input.events.wantsEvent('workspace.status.changed')) {
        consecutiveFailures = 0
        lastById.clear()
        return
      }
      if (!statuses) {
        if (consecutiveFailures < WORKSPACE_STATUS_MAX_RETRIES) {
          consecutiveFailures += 1
          shouldRetry = true
        }
        return
      }
      consecutiveFailures = 0
      for (const id of lastById.keys()) {
        if (!statuses.byId.has(id)) {
          lastById.delete(id)
        }
      }
      for (const [workspaceId, status] of statuses.byId) {
        const signature = JSON.stringify(status)
        if (signature !== lastById.get(workspaceId)) {
          lastById.set(workspaceId, signature)
          try {
            input.events.emitEvent('workspace.status.changed', { workspaceId, status })
          } catch {
            // One failed delivery must not drop the rest of the batch.
          }
        }
      }
    } finally {
      inFlight = false
      if (!stopped) {
        if (rerun) {
          rerun = false
          schedule()
        } else if (shouldRetry) {
          schedule(input.retryDelayMs ?? WORKSPACE_STATUS_RETRY_DELAY_MS)
        }
      }
    }
  }
  const schedule = (delayMs?: number): void => {
    if (stopped) {
      return
    }
    if (!input.events.wantsEvent('workspace.status.changed')) {
      lastById.clear()
      consecutiveFailures = 0
      return
    }
    if (inFlight) {
      rerun = true
      return
    }
    timer ??= setTimeout(
      () => void check(),
      delayMs ?? input.delayMs ?? WORKSPACE_STATUS_DEBOUNCE_MS
    )
  }
  const stopAgent = input.onAgentStatus(() => schedule())
  const stopSession = input.onSessionWritten(() => schedule())
  const stopState = input.onStateWritten((domains) => {
    if (
      domains === undefined ||
      domains.some((domain) => WORKSPACE_STATUS_STATE_DOMAINS.has(domain))
    ) {
      schedule()
    }
  })
  const stopLifecycle = input.onWorktreeLifecycle?.(() => schedule())
  return () => {
    stopped = true
    rerun = false
    stopAgent()
    stopSession()
    stopState()
    stopLifecycle?.()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
