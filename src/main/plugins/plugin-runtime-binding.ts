import type { PluginEventName } from '../../shared/plugins/manifest/plugin-manifest'
import { savedWorkspaceCatalog } from '../persistence/profile-save-domains'
import type { PluginAgentStatusChangedPayload } from '../../shared/plugins/events/plugin-events'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/workers/plugin-host-api'
import type { PluginRuntimeDelegate } from './workers/host-api/plugin-host-service-bindings'
import type { PluginService } from './plugin-service'
import { installPluginHookRunner } from './hooks/plugin-hook-participants'
import { installPluginResidentWorkerWarmer } from './workers/worker-admission/plugin-resident-worker'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { pluginRuntimeRpc } from './plugin-runtime-rpc'
import type { DispatcherOptions } from '../runtime/rpc/dispatcher'
import type { PluginRuntimeRpc } from './workers/host-api/plugin-host-runtime-call'
import {
  pluginTerminalTitle,
  projectPluginWorkspaceContext,
  terminalForPane,
  type PluginAgentStatusRow,
  type PluginWorkspaceContext,
  type PluginWorkspaceTerminal
} from './workers/host-api/plugin-workspace-projection'

type PluginEvents = {
  emitEvent(event: PluginEventName, payload: unknown): void
  /** Whether any approved worker or open panel listens, so unheard events cost nothing. */
  wantsEvent(event: PluginEventName): boolean
}

type RuntimeDelegateSource = Omit<PluginRuntimeDelegate, 'listAgentStatuses' | 'callRuntime'>

const WORKSPACE_CHANGE_DEBOUNCE_MS = 150

/** Main's runtime, plus the hook server's agent rows, as the plugin host's delegate. */
export function pluginRuntimeDelegate(
  runtime: RuntimeDelegateSource,
  agentStatuses: () => readonly PluginAgentStatusRow[],
  callRuntime?: PluginRuntimeRpc
): PluginRuntimeDelegate {
  return {
    ...(callRuntime ? { callRuntime } : {}),
    resolveActiveWorktreeContext: () => runtime.resolveActiveWorktreeContext(),
    listTerminals: (...args) => runtime.listTerminals(...args),
    sendTerminal: (...args) => runtime.sendTerminal(...args),
    dispatchPluginNotification: (input) => runtime.dispatchPluginNotification(input),
    listAgentStatuses: agentStatuses
  }
}

/** Binds the plugin host to main's runtime: its delegate, and the hooks Orca's own code runs. */
export function bindPluginRuntime(
  service: PluginService,
  runtime: OrcaRuntimeService,
  hookServer: { getStatusSnapshot(): readonly PluginAgentStatusRow[] },
  methods: DispatcherOptions['methods']
): PluginRuntimeDelegate {
  const statuses = () => hookServer.getStatusSnapshot()
  const delegate = pluginRuntimeDelegate(runtime, statuses, pluginRuntimeRpc(runtime, methods))
  service.setRuntimeDelegate(delegate)
  installPluginHookRunner(service, runtime)
  installPluginResidentWorkerWarmer(service)
  return delegate
}

async function listWorkspaceTerminals(
  delegate: PluginRuntimeDelegate,
  worktreeId: string
): Promise<PluginWorkspaceTerminal[]> {
  const { terminals } = await delegate.listTerminals(
    `id:${worktreeId}`,
    PLUGIN_WORKSPACE_TERMINAL_LIMIT,
    { includeVisualLayouts: false }
  )
  return terminals.map((terminal) => ({
    id: terminal.handle,
    title: pluginTerminalTitle(terminal),
    ...(terminal.tabId && terminal.leafId
      ? { paneKey: `${terminal.tabId}:${terminal.leafId}` }
      : {})
  }))
}

/**
 * `agent.status.changed` with the pane's `terminalId` and title, in arrival order. The lookup runs
 * only while some plugin listens: events queued behind a slow lookup share one terminal listing per
 * workspace, and are dropped once the last listener goes away.
 */
export function createPluginAgentStatusForwarder(
  delegate: PluginRuntimeDelegate,
  events: PluginEvents
): (payload: PluginAgentStatusChangedPayload, terminalHandle?: string) => void {
  type Pending = { payload: PluginAgentStatusChangedPayload; terminalHandle?: string }
  const pending: Pending[] = []
  let draining = false
  const drain = async (): Promise<void> => {
    // Why: start a microtask later so a synchronous burst lands in one batch.
    await Promise.resolve()
    try {
      while (pending.length > 0) {
        const batch = pending.splice(0)
        const lookups = new Map<string, Promise<PluginWorkspaceTerminal[]>>()
        for (const { payload, terminalHandle } of batch) {
          // Why: each listing refreshes every PTY provider and host. Interest is rechecked here,
          // not only on admission, so a backlog left by a closed panel stops running inventories.
          if (!events.wantsEvent('agent.status.changed')) {
            pending.length = 0
            return
          }
          const { workspaceId } = payload
          let lookup = workspaceId ? lookups.get(workspaceId) : undefined
          if (workspaceId && !lookup) {
            lookup = listWorkspaceTerminals(delegate, workspaceId).catch(() => [])
            lookups.set(workspaceId, lookup)
          }
          const terminals = lookup ? await lookup : []
          const terminal = terminalForPane(terminals, { paneKey: payload.paneKey, terminalHandle })
          try {
            events.emitEvent('agent.status.changed', {
              ...payload,
              ...(terminal ? { terminalId: terminal.id } : {}),
              ...(terminal?.title ? { title: terminal.title } : {})
            })
          } catch {
            // Why: one failed delivery must not drop the rest of the batch or strand the queue.
          }
        }
      }
    } finally {
      // Why: cleared in the same turn as the last empty-queue check, so no event can strand.
      draining = false
    }
  }
  return (payload, terminalHandle) => {
    if (!events.wantsEvent('agent.status.changed')) {
      return
    }
    pending.push({ payload, terminalHandle })
    if (!draining) {
      draining = true
      void drain()
    }
  }
}

/**
 * The `workspace.changed` payload for the context as it is now, plus the focused worktree id the
 * watcher dedupes on (kept out of the payload because it can embed a provider path).
 */
export async function readPluginWorkspaceChange(delegate: PluginRuntimeDelegate): Promise<{
  change: { context: PluginWorkspaceContext }
  worktreeId: string | null
}> {
  const context = await delegate.resolveActiveWorktreeContext().catch(() => null)
  const terminals = context
    ? await listWorkspaceTerminals(delegate, context.worktreeId).catch(() => [])
    : []
  return {
    change: { context: projectPluginWorkspaceContext(context, terminals) },
    worktreeId: context?.worktreeId ?? null
  }
}

/**
 * `workspace.changed`: after workspace session writes settle (focus moves, terminals open, close
 * or are renamed), re-read the context and emit when it differs from the last one sent.
 * Why: compare by worktree id too, so focus moving between identical-looking workspaces still emits.
 */
export function watchPluginWorkspaceContext(input: {
  delegate: PluginRuntimeDelegate
  events: PluginEvents
  onSessionWritten: (listener: () => void) => () => void
  onStateWritten: (listener: (domains: readonly string[] | undefined) => void) => () => void
  delayMs?: number
}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: string | null = null
  const check = async (): Promise<void> => {
    timer = null
    if (!input.events.wantsEvent('workspace.changed')) {
      last = null
      return
    }
    const { change, worktreeId } = await readPluginWorkspaceChange(input.delegate)
    const signature = JSON.stringify({ worktreeId, change })
    if (signature !== last) {
      last = signature
      input.events.emitEvent('workspace.changed', change)
    }
  }
  const schedule = (): void => {
    timer ??= setTimeout(() => void check(), input.delayMs ?? WORKSPACE_CHANGE_DEBOUNCE_MS)
  }
  const stopSession = input.onSessionWritten(schedule)
  // A folder workspace rename reaches the context through the catalog, not the session.
  const stopCatalog = input.onStateWritten((domains) => {
    if (savedWorkspaceCatalog(domains)) {
      schedule()
    }
  })
  return () => {
    stopSession()
    stopCatalog()
    if (timer) {
      clearTimeout(timer)
    }
  }
}
